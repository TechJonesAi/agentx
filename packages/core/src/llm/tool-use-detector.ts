/**
 * Tool-Use Detector — semantic-failure detection for AgentX's chat loop.
 *
 * Problem this solves: small local models (e.g. qwen3:14b) sometimes respond
 * to action-shaped requests ("save this file…", "take a screenshot…") with
 * HTTP 200 but NO tool_use emission. Instead they:
 *   1. Echo the tool call back as plain text: `save_file(filename="x.txt", …)`
 *   2. Refuse falsely: "I cannot execute these steps / skill not available"
 *   3. Offer to do it conversationally without actually firing a tool
 *
 * None of these are HTTP errors, so the existing retry/circuit-breaker /
 * performance-store logic does not notice. The chat pipeline then returns
 * the bad response to the user and the signal is lost.
 *
 * This detector produces a boolean verdict + a reason code that the chat
 * pipeline can act on (auto-retry against a stronger model) and the
 * performance store can persist (demote weak tool-callers over time).
 *
 * Design principle: be conservative on CLASSIFYING A REQUEST as action-shaped
 * (false positives slow down normal Q&A), but once classified, be aggressive
 * about flagging weak responses. This matches the user's requested
 * "Aggressive" escalation policy.
 */

export interface ToolUseDetectorInput {
  /** The user's most-recent message that triggered this turn. */
  userMessage: string;
  /** Tools that were in scope for this call (their names). */
  availableTools: string[];
  /** The LLM's raw reply content (text-only portion). */
  responseContent: string;
  /** Number of actual tool_use blocks the LLM emitted. 0 = none. */
  toolCallCount: number;
}

export type ToolUseMissReason =
  | 'tool_call_syntax_as_text'   // model printed `foo_bar(x=…)` instead of calling it
  | 'false_refusal'              // model said "I can't" despite tools being available
  | 'action_without_tool_use'    // action-shaped request, zero tool calls, no visible reason
  | 'none';                      // response looks fine

export interface ToolUseDetectorResult {
  /** Does the user's message look like it needs a tool to fulfil? */
  expectedToolUse: boolean;
  /** Did the LLM actually emit at least one tool_use? */
  hadToolCall: boolean;
  /** Verdict: "tools were expected but missed." */
  toolUseMissed: boolean;
  /** Which of the three failure modes we detected (if any). */
  reason: ToolUseMissReason;
  /**
   * Short human-readable explanation — good for logs/events and for
   * recording alongside the negative performance signal.
   */
  detail: string;
}

// ─── Action-shape classifier ────────────────────────────────────────────────

/**
 * Verbs that strongly imply the caller wants AgentX to ACT on the real system,
 * not just discuss. Kept deliberately tight to avoid firing on questions like
 * "can you write better code?" or "tell me about screenshots".
 *
 * Each pattern is anchored with \b word boundaries and uses case-insensitive
 * matching.
 */
const ACTION_INTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // File / write operations
  /\b(save|write|create|append|overwrite|persist)\s+(this|that|the|a|an|my|it)?\s*(file|content|text|story|document|note|log|report|code)/i,
  /\bsave[-_ ]?(as|to)\b/i,
  /\bwrite\s+to\s+(a\s+)?file\b/i,
  // Computer control
  /\btake\s+a?\s*screenshot\b/i,
  /\bcapture\s+(the\s+)?screen\b/i,
  /\b(open|launch|start)\s+(textedit|safari|chrome|finder|terminal|calendar|mail|notes|pages|numbers|keynote)\b/i,
  /\b(click|press|tap)\s+(at|on|the)\b/i,
  /\btype\s+['"]/i,
  // Shell / execution
  /\brun\s+(this|that|the)?\s*(command|shell|script)\b/i,
  /\bexecute\s+(this|that)?\s*(command|shell|script)\b/i,
  // Explicit tool mentions
  /\buse\s+(the\s+)?(save_file|shell|computer_\w+|file_read|file_write)\s+(tool|skill)\b/i,
  /\bcall\s+(the\s+)?(save_file|shell|computer_\w+|file_read|file_write)\b/i,
  // Imperative multi-step flows
  /\bstep\s+\d\s*[:.)-]/i,
];

/** Classify whether the user message is action-shaped. */
export function isActionShapedMessage(userMessage: string): boolean {
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return false;
  return ACTION_INTENT_PATTERNS.some(re => re.test(trimmed));
}

// ─── Weak-response detectors ────────────────────────────────────────────────

/**
 * Detect when the model printed a tool-call as plain text instead of emitting
 * a real tool_use. Pattern: identifier followed by parens with key="value"
 * arguments, appearing in a response that had zero tool_calls.
 *
 * Example caught:
 *   save_file(filename="~/x.txt", content="hello")
 *   computer_screenshot(destPath="~/a.png")
 *
 * Matches on the tool name prefix when possible (so we don't false-positive
 * on math like `sum(x,y,z)`).
 */
function hasToolCallSyntaxAsText(content: string, availableTools: string[]): boolean {
  if (availableTools.length === 0) return false;
  // Escape tool names for regex and build an alternation.
  const escaped = availableTools.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Match: <tool_name>(<anything containing = and ">)
  const re = new RegExp(`\\b(${escaped})\\s*\\(\\s*[a-zA-Z_][\\w]*\\s*=\\s*["']`, 'm');
  return re.test(content);
}

/** Phrases that indicate a refusal that shouldn't have happened. */
const FALSE_REFUSAL_PHRASES: ReadonlyArray<RegExp> = [
  /\bi\s+cannot\s+execute\b/i,
  /\bi\s+can't\s+execute\b/i,
  /\bi\s+am\s+unable\s+to\s+(execute|create|save|write)\b/i,
  /\bskill\s+is\s+not\s+available\b/i,
  /\btool\s+is\s+not\s+available\b/i,
  /\bnot\s+available\s+in\s+the\s+current\s+system\b/i,
  /\bdue\s+to\s+system\s+(restrictions|limitations)\b/i,
  /\bi\s+don'?t\s+have\s+(the\s+)?(ability|capability|access)\s+to\b/i,
];

function hasFalseRefusal(content: string): boolean {
  return FALSE_REFUSAL_PHRASES.some(re => re.test(content));
}

// ─── Main entry point ───────────────────────────────────────────────────────

export function analyzeToolUse(input: ToolUseDetectorInput): ToolUseDetectorResult {
  const expectedToolUse = isActionShapedMessage(input.userMessage);
  const hadToolCall = input.toolCallCount > 0;

  // If tools were used OR the request wasn't action-shaped, we're fine.
  if (!expectedToolUse || hadToolCall) {
    return {
      expectedToolUse,
      hadToolCall,
      toolUseMissed: false,
      reason: 'none',
      detail: hadToolCall
        ? `Tools used (${input.toolCallCount}).`
        : 'Request did not require tool use.',
    };
  }

  // Tools expected, none used. Diagnose WHY so the escalation response can
  // explain itself in logs and so the performance store can record a finer-
  // grained signal than just "missed".
  if (hasToolCallSyntaxAsText(input.responseContent, input.availableTools)) {
    return {
      expectedToolUse: true,
      hadToolCall: false,
      toolUseMissed: true,
      reason: 'tool_call_syntax_as_text',
      detail: 'Model echoed tool-call syntax as plain text instead of emitting a tool_use block.',
    };
  }

  if (hasFalseRefusal(input.responseContent)) {
    return {
      expectedToolUse: true,
      hadToolCall: false,
      toolUseMissed: true,
      reason: 'false_refusal',
      detail: 'Model refused to act despite having the required tools available.',
    };
  }

  return {
    expectedToolUse: true,
    hadToolCall: false,
    toolUseMissed: true,
    reason: 'action_without_tool_use',
    detail: 'Action-shaped request received a text-only response with no tool use.',
  };
}
