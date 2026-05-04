import { describe, it, expect } from 'vitest';
import { IntentClassifier, type QueryIntent } from '../../src/reasoning/intent-classifier.js';

const c = new IntentClassifier();

function expectIntent(query: string, expected: QueryIntent) {
  expect(c.classify(query)).toBe(expected);
}

describe('IntentClassifier — fact_extraction (question form)', () => {
  it('classifies "What is the capital of France?" as fact_extraction', () => {
    expectIntent('What is the capital of France?', 'fact_extraction');
  });
  it('classifies "Who wrote Hamlet?" as fact_extraction', () => {
    expectIntent('Who wrote Hamlet?', 'fact_extraction');
  });
  it('classifies "When did World War II end?" as fact_extraction', () => {
    expectIntent('When did World War II end?', 'fact_extraction');
  });
  it('classifies "Where is Mount Everest located?" as fact_extraction', () => {
    expectIntent('Where is Mount Everest located?', 'fact_extraction');
  });
  it('classifies "Which year was Bitcoin launched?" as fact_extraction', () => {
    expectIntent('Which year was Bitcoin launched?', 'fact_extraction');
  });
  it('classifies "Why is the sky blue?" as fact_extraction', () => {
    expectIntent('Why is the sky blue?', 'fact_extraction');
  });
  it('handles leading whitespace before fact question', () => {
    expectIntent('   What is 2+2?', 'fact_extraction');
  });
  it('is case-insensitive (UPPER)', () => {
    expectIntent('WHO INVENTED THE TELEPHONE?', 'fact_extraction');
  });
});

describe('IntentClassifier — fact_extraction (imperative form)', () => {
  it('classifies "Find the contract clauses" as fact_extraction', () => {
    expectIntent('Find the contract clauses', 'fact_extraction');
  });
  it('classifies "Show me the latest invoices" as fact_extraction', () => {
    expectIntent('Show me the latest invoices', 'fact_extraction');
  });
  it('classifies "List all employees" as fact_extraction', () => {
    expectIntent('List all employees', 'fact_extraction');
  });
  it('classifies "Extract the names from the document" as fact_extraction', () => {
    expectIntent('Extract the names from the document', 'fact_extraction');
  });
  it('classifies "Get the patient history" as fact_extraction', () => {
    expectIntent('Get the patient history', 'fact_extraction');
  });
  it('classifies "Look up the postal code" as fact_extraction', () => {
    expectIntent('Look up the postal code', 'fact_extraction');
  });
  it('classifies "Tell me the date of birth" as fact_extraction', () => {
    expectIntent('Tell me the date of birth', 'fact_extraction');
  });
});

describe('IntentClassifier — strategy', () => {
  it('classifies "How do I cook risotto?" as strategy', () => {
    expectIntent('How do I cook risotto?', 'strategy');
  });
  it('classifies "How should I respond?" as strategy', () => {
    expectIntent('How should I respond to this email?', 'strategy');
  });
  it('classifies "How can I improve performance?" as strategy', () => {
    expectIntent('How can I improve performance?', 'strategy');
  });
  it('classifies "How would I approach this?" as strategy', () => {
    expectIntent('How would I approach this problem?', 'strategy');
  });
  it('classifies "How might I refactor this?" as strategy', () => {
    expectIntent('How might I refactor this?', 'strategy');
  });
  it('classifies "How to deploy a Node app" as strategy', () => {
    expectIntent('How to deploy a Node app', 'strategy');
  });
  it('classifies "What is the best way to learn TypeScript" as strategy (no question mark, strategy-only)', () => {
    // With trailing "?", this triggers BOTH fact-question and strategy and would be 'general'.
    // Without "?", only strategy matches.
    expectIntent('What is the best way to learn TypeScript', 'strategy');
  });
  it('classifies "What\'s the best way to plan a trip" as strategy (straight apostrophe)', () => {
    expectIntent("What's the best way to plan a trip", 'strategy');
  });
  it('classifies "What’s the best way to learn" as strategy (curly apostrophe)', () => {
    expectIntent('What’s the best way to learn', 'strategy');
  });
  it('classifies "Plan a trip to Tokyo" as strategy', () => {
    expectIntent('Plan a trip to Tokyo', 'strategy');
  });
  it('classifies "Plan my week" as strategy', () => {
    expectIntent('Plan my week', 'strategy');
  });
  it('classifies "Help me debug this error" as strategy', () => {
    expectIntent('Help me debug this error', 'strategy');
  });
  it('classifies "Help me write a function" as strategy', () => {
    expectIntent('Help me write a function', 'strategy');
  });
});

describe('IntentClassifier — general', () => {
  it('classifies empty string as general', () => {
    expectIntent('', 'general');
  });
  it('classifies whitespace-only as general', () => {
    expectIntent('   ', 'general');
  });
  it('classifies a greeting as general', () => {
    expectIntent('Hello', 'general');
  });
  it('classifies a thanks as general', () => {
    expectIntent('Thanks!', 'general');
  });
  it('classifies a declarative as general', () => {
    expectIntent('I think we should consider this option.', 'general');
  });
  it('classifies a meeting note as general', () => {
    expectIntent('The meeting is at 3pm.', 'general');
  });
  it('classifies an acknowledgement as general', () => {
    expectIntent('Yes, that works.', 'general');
  });
  it('classifies a casual statement as general', () => {
    expectIntent('Pizza is delicious.', 'general');
  });
  it('classifies an emoji-only message as general', () => {
    expectIntent('🙂🙂🙂', 'general');
  });
  it('classifies ellipsis as general', () => {
    expectIntent('...', 'general');
  });
  it('classifies a non-string input as general', () => {
    expectIntent(undefined as unknown as string, 'general');
  });
  it('classifies a question lacking fact word as general', () => {
    // "Is" is a question but not a fact-extraction trigger word.
    expectIntent('Is the meeting still on?', 'general');
  });
});

describe('IntentClassifier — disambiguation (general wins on overlap)', () => {
  it('returns general when both strategy and fact-imperative match', () => {
    // "Find" at start triggers fact-imperative; "help me" anywhere triggers strategy → general
    expectIntent('Find help me debug this issue', 'general');
  });
  it('returns general when strategy matches and a fact question word starts the query', () => {
    // "What is the best way" is strategy; "What" is also a fact question word — overlap.
    expectIntent('What is the best way to find the contract?', 'general');
  });
  it('returns general when fact imperative starts the query and "help me" appears later', () => {
    // "Show" at start → fact imperative; "help me" anywhere → strategy → general
    expectIntent('Show help me the documentation', 'general');
  });
});

describe('IntentClassifier — edge cases', () => {
  it('handles very long input without crashing', () => {
    const long = 'What is ' + 'a '.repeat(2000) + 'thing?';
    expectIntent(long, 'fact_extraction');
  });
  it('handles input with only punctuation as general', () => {
    expectIntent('?!?!', 'general');
  });
  it('treats unknown imperative verb as general', () => {
    expectIntent('Investigate the data', 'general');
  });
  it('does not classify "what" mid-sentence as fact', () => {
    expectIntent('I wonder what happened.', 'general');
  });
  it('classifies a question mark without a trigger word as general', () => {
    expectIntent('Tomorrow?', 'general');
  });
});
