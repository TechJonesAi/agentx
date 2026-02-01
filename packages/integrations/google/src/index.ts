/**
 * Google Integration for AgentX
 *
 * Provides Gmail and Google Calendar access via the Google APIs.
 * Requires OAuth2 credentials (client ID, client secret).
 */

import { type Agent, type Integration, type Tool, type CredentialManager, createLogger } from '@agentx/core';

const log = createLogger('integration:google');

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface Email {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  body?: string;
  labels: string[];
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
  status: string;
}

export interface TimeSlot {
  start: string;
  end: string;
}

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope: string;
}

/**
 * Google integration providing Gmail and Calendar access.
 */
export class GoogleIntegration implements Integration {
  readonly name = 'google';
  private agent: Agent;
  private config: GoogleConfig;
  private tokens: TokenData | null = null;
  private credentials: CredentialManager;

  constructor(agent: Agent, config: GoogleConfig) {
    this.agent = agent;
    this.config = config;
    this.credentials = agent.getCredentialManager();
  }

  private async loadTokens(): Promise<void> {
    try {
      const accessToken = await this.credentials.getCredential('GOOGLE_ACCESS_TOKEN');
      const refreshToken = await this.credentials.getCredential('GOOGLE_REFRESH_TOKEN');
      const expiryStr = await this.credentials.getCredential('GOOGLE_TOKEN_EXPIRY');
      const scope = await this.credentials.getCredential('GOOGLE_TOKEN_SCOPE');

      if (accessToken) {
        this.tokens = {
          access_token: accessToken,
          refresh_token: refreshToken ?? undefined,
          expiry_date: expiryStr ? parseInt(expiryStr, 10) : undefined,
          token_type: 'Bearer',
          scope: scope ?? '',
        };
        log.info('Google tokens loaded from credential store');
      }
    } catch (error) {
      log.warn({ error }, 'Failed to load Google tokens');
    }
  }

  private async saveTokens(): Promise<void> {
    if (!this.tokens) return;
    try {
      await this.credentials.setCredential('GOOGLE_ACCESS_TOKEN', this.tokens.access_token);
      if (this.tokens.refresh_token) {
        await this.credentials.setCredential('GOOGLE_REFRESH_TOKEN', this.tokens.refresh_token);
      }
      if (this.tokens.expiry_date) {
        await this.credentials.setCredential('GOOGLE_TOKEN_EXPIRY', String(this.tokens.expiry_date));
      }
      if (this.tokens.scope) {
        await this.credentials.setCredential('GOOGLE_TOKEN_SCOPE', this.tokens.scope);
      }
    } catch (error) {
      log.error({ error }, 'Failed to save Google tokens to credential store');
    }
  }

  isAuthenticated(): boolean {
    return !!this.tokens?.access_token;
  }

  /**
   * Get the OAuth2 authorization URL for the user to visit.
   */
  getAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   */
  async handleCallback(code: string): Promise<void> {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
    }

    this.tokens = await response.json() as TokenData;
    await this.saveTokens();
    log.info('Google OAuth tokens obtained');
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available. Re-authorize.');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.tokens.refresh_token,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = await response.json() as Partial<TokenData>;
    this.tokens = { ...this.tokens, ...data };
    await this.saveTokens();
  }

  private async getHeaders(): Promise<Record<string, string>> {
    if (!this.tokens) throw new Error('Not authenticated. Call getAuthUrl() first.');

    // Check if token is expired
    if (this.tokens.expiry_date && Date.now() >= this.tokens.expiry_date - 60_000) {
      await this.refreshAccessToken();
    }

    return {
      Authorization: `Bearer ${this.tokens.access_token}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── Gmail ───────────────────────────────────────────────────────────────────

  async listEmails(query = '', maxResults = 10): Promise<Email[]> {
    const headers = await this.getHeaders();
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });

    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers },
    );

    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
    const list = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> };

    if (!list.messages?.length) return [];

    const emails: Email[] = [];
    for (const msg of list.messages.slice(0, maxResults)) {
      const detail = await this.getEmail(msg.id);
      emails.push(detail);
    }

    return emails;
  }

  async getEmail(id: string): Promise<Email> {
    const headers = await this.getHeaders();
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
      { headers },
    );

    if (!res.ok) throw new Error(`Gmail get failed: ${res.status}`);
    const msg = await res.json() as {
      id: string;
      threadId: string;
      snippet: string;
      labelIds: string[];
      payload: { headers: Array<{ name: string; value: string }> };
    };

    const getHeader = (name: string) =>
      msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader('Subject'),
      from: getHeader('From'),
      to: getHeader('To'),
      date: getHeader('Date'),
      snippet: msg.snippet,
      labels: msg.labelIds ?? [],
    };
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    const headers = await this.getHeaders();
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    ).toString('base64url');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) throw new Error(`Gmail send failed: ${res.status}`);
    log.info({ to, subject }, 'Email sent');
  }

  async replyToEmail(threadId: string, body: string): Promise<void> {
    const headers = await this.getHeaders();

    // Get the original message to extract headers
    const threadRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`,
      { headers },
    );
    if (!threadRes.ok) throw new Error(`Thread fetch failed: ${threadRes.status}`);
    const thread = await threadRes.json() as {
      messages: Array<{
        payload: { headers: Array<{ name: string; value: string }> };
        id: string;
      }>;
    };

    const lastMessage = thread.messages[thread.messages.length - 1]!;
    const getHeader = (name: string) =>
      lastMessage.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

    const to = getHeader('From');
    const subject = `Re: ${getHeader('Subject')}`;
    const messageId = getHeader('Message-ID');

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nIn-Reply-To: ${messageId}\r\nReferences: ${messageId}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    ).toString('base64url');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ raw, threadId }),
    });

    if (!res.ok) throw new Error(`Gmail reply failed: ${res.status}`);
    log.info({ threadId, to }, 'Reply sent');
  }

  async markAsRead(id: string): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      },
    );
    if (!res.ok) throw new Error(`Gmail modify failed: ${res.status}`);
  }

  // ─── Calendar ────────────────────────────────────────────────────────────────

  async listEvents(start: Date, end: Date, calendarId = 'primary'): Promise<CalendarEvent[]> {
    const headers = await this.getHeaders();
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`,
      { headers },
    );

    if (!res.ok) throw new Error(`Calendar list failed: ${res.status}`);
    const data = await res.json() as {
      items: Array<{
        id: string;
        summary: string;
        description?: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        location?: string;
        attendees?: Array<{ email: string }>;
        status: string;
      }>;
    };

    return (data.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary,
      description: item.description,
      start: item.start.dateTime ?? item.start.date ?? '',
      end: item.end.dateTime ?? item.end.date ?? '',
      location: item.location,
      attendees: item.attendees?.map((a) => a.email),
      status: item.status,
    }));
  }

  async createEvent(event: {
    summary: string;
    description?: string;
    start: string;
    end: string;
    location?: string;
    attendees?: string[];
  }, calendarId = 'primary'): Promise<CalendarEvent> {
    const headers = await this.getHeaders();

    const body = {
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      location: event.location,
      attendees: event.attendees?.map((email) => ({ email })),
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );

    if (!res.ok) throw new Error(`Calendar create failed: ${res.status}`);
    const created = await res.json() as {
      id: string;
      summary: string;
      description?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      location?: string;
      attendees?: Array<{ email: string }>;
      status: string;
    };

    log.info({ eventId: created.id, summary: event.summary }, 'Calendar event created');

    return {
      id: created.id,
      summary: created.summary,
      description: created.description,
      start: created.start.dateTime ?? created.start.date ?? '',
      end: created.end.dateTime ?? created.end.date ?? '',
      location: created.location,
      attendees: created.attendees?.map((a) => a.email),
      status: created.status,
    };
  }

  async deleteEvent(eventId: string, calendarId = 'primary'): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${eventId}`,
      { method: 'DELETE', headers },
    );
    if (!res.ok) throw new Error(`Calendar delete failed: ${res.status}`);
    log.info({ eventId }, 'Calendar event deleted');
  }

  async checkAvailability(start: Date, end: Date): Promise<TimeSlot[]> {
    const events = await this.listEvents(start, end);
    const busySlots = events.map((e) => ({
      start: new Date(e.start).getTime(),
      end: new Date(e.end).getTime(),
    }));

    // Find free slots
    const freeSlots: TimeSlot[] = [];
    let cursor = start.getTime();

    for (const busy of busySlots) {
      if (cursor < busy.start) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(busy.start).toISOString(),
        });
      }
      cursor = Math.max(cursor, busy.end);
    }

    if (cursor < end.getTime()) {
      freeSlots.push({
        start: new Date(cursor).toISOString(),
        end: end.toISOString(),
      });
    }

    return freeSlots;
  }

  // ─── Tools ───────────────────────────────────────────────────────────────────

  getTools(): Tool[] {
    return [
      {
        definition: {
          name: 'read_emails',
          description: 'Search and read emails from Gmail',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Gmail search query (e.g. "is:unread", "from:someone@email.com")' },
              maxResults: { type: 'number', description: 'Max emails to return (default: 5)' },
            },
          },
        },
        execute: async (args) => {
          const emails = await this.listEmails(
            args['query'] as string ?? '',
            (args['maxResults'] as number) ?? 5,
          );
          return JSON.stringify(emails, null, 2);
        },
      },
      {
        definition: {
          name: 'send_email',
          description: 'Send an email via Gmail',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address' },
              subject: { type: 'string', description: 'Email subject' },
              body: { type: 'string', description: 'Email body text' },
            },
            required: ['to', 'subject', 'body'],
          },
        },
        execute: async (args) => {
          await this.sendEmail(args['to'] as string, args['subject'] as string, args['body'] as string);
          return 'Email sent successfully.';
        },
      },
      {
        definition: {
          name: 'reply_to_email',
          description: 'Reply to an email thread in Gmail',
          parameters: {
            type: 'object',
            properties: {
              threadId: { type: 'string', description: 'Gmail thread ID to reply to' },
              body: { type: 'string', description: 'Reply body text' },
            },
            required: ['threadId', 'body'],
          },
        },
        execute: async (args) => {
          await this.replyToEmail(args['threadId'] as string, args['body'] as string);
          return 'Reply sent successfully.';
        },
      },
      {
        definition: {
          name: 'list_calendar_events',
          description: 'List upcoming Google Calendar events',
          parameters: {
            type: 'object',
            properties: {
              startDate: { type: 'string', description: 'Start date (ISO 8601, default: now)' },
              endDate: { type: 'string', description: 'End date (ISO 8601, default: 7 days from now)' },
            },
          },
        },
        execute: async (args) => {
          const start = args['startDate'] ? new Date(args['startDate'] as string) : new Date();
          const end = args['endDate'] ? new Date(args['endDate'] as string) : new Date(Date.now() + 7 * 86400000);
          const events = await this.listEvents(start, end);
          return JSON.stringify(events, null, 2);
        },
      },
      {
        definition: {
          name: 'create_calendar_event',
          description: 'Create a new Google Calendar event',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Event title' },
              start: { type: 'string', description: 'Start time (ISO 8601)' },
              end: { type: 'string', description: 'End time (ISO 8601)' },
              description: { type: 'string', description: 'Event description' },
              location: { type: 'string', description: 'Event location' },
            },
            required: ['summary', 'start', 'end'],
          },
        },
        execute: async (args) => {
          const event = await this.createEvent({
            summary: args['summary'] as string,
            start: args['start'] as string,
            end: args['end'] as string,
            description: args['description'] as string | undefined,
            location: args['location'] as string | undefined,
          });
          return JSON.stringify(event, null, 2);
        },
      },
      {
        definition: {
          name: 'check_availability',
          description: 'Check calendar availability for a time range',
          parameters: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Start of range (ISO 8601)' },
              end: { type: 'string', description: 'End of range (ISO 8601)' },
            },
            required: ['start', 'end'],
          },
        },
        execute: async (args) => {
          const slots = await this.checkAvailability(
            new Date(args['start'] as string),
            new Date(args['end'] as string),
          );
          return JSON.stringify({ freeSlots: slots }, null, 2);
        },
      },
    ];
  }

  // ─── Integration lifecycle ───────────────────────────────────────────────────

  async sendMessage(_target: string, _message: string): Promise<void> {
    // Not applicable for Google integration
  }

  async start(): Promise<void> {
    await this.loadTokens();
    if (this.isAuthenticated()) {
      log.info('Google integration started (authenticated)');
    } else {
      log.info('Google integration started (not authenticated — visit auth URL to connect)');
    }
  }

  async stop(): Promise<void> {
    log.info('Google integration stopped');
  }
}
