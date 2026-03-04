/**
 * Ntfy publisher implementation for sending notifications
 */
import { DEFAULT_NTFY_BASE_URL, DEFAULT_REQUEST_TIMEOUT, ERROR_MESSAGES } from './constants.js';
import { NtfyAuthenticationError, NtfyConnectionError, NtfyInvalidTopicError, ntfyErrorMapper } from './errors.js';
import { NtfyAction, NtfyAttachment, NtfyPriority } from './types.js';
import { 
  createTimeout, 
  validateTopicSync, 
  createRequestHeadersSync 
} from './utils.js';
import { BaseErrorCode, McpError } from '../../types-global/errors.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput, sanitizeInputForLogging } from '../../utils/sanitization.js';
import { createRequestContext } from '../../utils/requestContext.js';
import { idGenerator } from '../../utils/idGenerator.js';

// Create a module-specific logger
const publisherLogger = logger.createChildLogger({ 
  module: 'NtfyPublisher',
  serviceId: idGenerator.generateRandomString(8)
});

/**
 * Options for publishing to ntfy topics
 */
export interface NtfyPublishOptions {
  /** Base URL for the ntfy server */
  baseUrl?: string;
  /** Authentication token */
  auth?: string;
  /** Basic auth username */
  username?: string;
  /** Basic auth password */
  password?: string;
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  /** Message title */
  title?: string;
  /** Message tags (emojis) */
  tags?: string[];
  /** Message priority (1-5) */
  priority?: NtfyPriority;
  /** URL to open when notification is clicked */
  click?: string;
  /** Message actions (buttons, etc.) */
  actions?: NtfyAction[];
  /** Message attachment */
  attachment?: NtfyAttachment;
  /** Email addresses to send the notification to */
  email?: string;
  /** Delay the message for a specific time (e.g., 30m, 1h, tomorrow) */
  delay?: string;
  /** Cache the message for a specific duration (e.g., 10m, 1h, 1d) */
  cache?: string;
  /** Firebase Cloud Messaging (FCM) topic to forward to */
  firebase?: string;
  /** Unique ID for the message */
  id?: string;
  /** Message expiration (e.g., 10m, 1h, 1d) */
  expires?: string;
  /** Whether the message should be X-Forwarded */
  markdown?: boolean;
}

/**
 * Response from publishing to ntfy
 */
export interface NtfyPublishResponse {
  /** Server-assigned message ID */
  id: string;
  /** Time the message was received */
  time: number;
  /** Message expiration timestamp (if set) */
  expires?: number;
  /** Topic the message was published to */
  topic: string;
}

/**
 * Publish a message to a ntfy topic
 * 
 * @param topic - Topic to publish to
 * @param message - Message to publish
 * @param options - Publishing options
 * @returns Promise resolving to the publish response
 * @throws NtfyInvalidTopicError if the topic name is invalid
 * @throws NtfyConnectionError if the connection fails
 */
export async function publish(
  topic: string,
  message: string,
  options: NtfyPublishOptions = {}
): Promise<NtfyPublishResponse> {
  return ErrorHandler.tryCatch(
    async () => {
      // Create request context for tracking
      const requestCtx = createRequestContext({
        operation: 'publishNtfyMessage',
        topic,
        messageLength: message?.length,
        hasTitle: !!options.title,
        hasTags: Array.isArray(options.tags) && options.tags.length > 0,
        priority: options.priority,
        publishId: idGenerator.generateRandomString(8)
      });

      publisherLogger.info('Publishing message', { 
        topic,
        messageLength: message?.length,
        hasTitle: !!options.title,
        hasTags: Array.isArray(options.tags) && options.tags.length > 0,
        priority: options.priority,
        requestId: requestCtx.requestId
      });
      
      // Validate topic synchronously for better performance
      if (!validateTopicSync(topic)) {
        publisherLogger.error('Invalid topic name', { 
          topic,
          requestId: requestCtx.requestId 
        });
        throw new NtfyInvalidTopicError(ERROR_MESSAGES.INVALID_TOPIC, topic);
      }

      // Build URL - baseUrl comes from trusted config, don't validate as public URL
      const baseUrl = (options.baseUrl || DEFAULT_NTFY_BASE_URL).replace(/\/+$/, '');
      const url = `${baseUrl}/${sanitizeInput.string(topic)}`;
      
      publisherLogger.debug('Publishing to URL', { 
        url,
        requestId: requestCtx.requestId 
      });
      
      // Prepare headers - using sync version for performance
      const initialHeaders = createRequestHeadersSync({
        auth: options.auth,
        username: options.username,
        password: options.password,
        headers: options.headers,
      });

      // Convert HeadersInit to a Record for easier manipulation
      const headers: Record<string, string> = {};
      
      // Copy initial headers to our record object
      if (initialHeaders instanceof Headers) {
        initialHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(initialHeaders)) {
        for (const [key, value] of initialHeaders) {
          headers[key] = value;
        }
      } else if (initialHeaders) {
        Object.assign(headers, initialHeaders);
      }

      // Set content type
      headers['Content-Type'] = 'text/plain';

      // Add special headers for ntfy features
      if (options.title) {
        headers['X-Title'] = sanitizeInput.string(options.title);
      }

      if (options.tags && options.tags.length > 0) {
        // Sanitize each tag
        const sanitizedTags = options.tags.map(tag => sanitizeInput.string(tag));
        headers['X-Tags'] = sanitizedTags.join(',');
      }

      if (options.priority) {
        headers['X-Priority'] = options.priority.toString();
      }

      if (options.click) {
        headers['X-Click'] = sanitizeInput.url(options.click);
      }

      if (options.actions && options.actions.length > 0) {
        // We need to sanitize the actions
        const sanitizedActions = options.actions.map(action => ({
          id: sanitizeInput.string(action.id),
          label: sanitizeInput.string(action.label),
          action: sanitizeInput.string(action.action),
          url: action.url ? sanitizeInput.url(action.url) : undefined,
          method: action.method ? sanitizeInput.string(action.method) : undefined,
          headers: action.headers,
          body: action.body ? sanitizeInput.string(action.body) : undefined,
          clear: action.clear
        }));
        headers['X-Actions'] = JSON.stringify(sanitizedActions);
      }

      if (options.attachment) {
        headers['X-Attach'] = sanitizeInput.url(options.attachment.url);
        if (options.attachment.name) {
          headers['X-Filename'] = sanitizeInput.string(options.attachment.name);
        }
      }

      if (options.email) {
        headers['X-Email'] = sanitizeInput.string(options.email);
      }

      if (options.delay) {
        headers['X-Delay'] = sanitizeInput.string(options.delay);
      }

      if (options.cache) {
        headers['X-Cache'] = sanitizeInput.string(options.cache);
      }

      if (options.firebase) {
        headers['X-Firebase'] = sanitizeInput.string(options.firebase);
      }

      if (options.id) {
        headers['X-ID'] = sanitizeInput.string(options.id);
      }

      if (options.expires) {
        headers['X-Expires'] = sanitizeInput.string(options.expires);
      }

      if (options.markdown) {
        headers['X-Markdown'] = 'true';
      }

      // Send request with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT);

      try {
        publisherLogger.debug('Sending HTTP request', { 
          url, 
          method: 'POST',
          requestId: requestCtx.requestId 
        });
        
        const response = await Promise.race([
          fetch(url, {
            method: 'POST',
            headers,
            body: message,
            signal: controller.signal,
          }),
          createTimeout(DEFAULT_REQUEST_TIMEOUT),
        ]);

        clearTimeout(timeoutId);

        // Check response status
        if (!response.ok) {
          publisherLogger.error('HTTP error from ntfy server', { 
            status: response.status, 
            statusText: response.statusText,
            url,
            requestId: requestCtx.requestId
          });
          
          // Provide more specific error messages based on status code
          let errorMessage = `HTTP Error: ${response.status} ${response.statusText}`;
          
          switch (response.status) {
            case 401:
              errorMessage = 'Authentication failed: invalid credentials';
              throw new NtfyAuthenticationError(errorMessage);
            case 403:
              errorMessage = 'Access forbidden: insufficient permissions';
              throw new McpError(
                BaseErrorCode.FORBIDDEN, 
                errorMessage, 
                { url, statusCode: response.status }
              );
            case 404:
              errorMessage = 'Topic or resource not found';
              throw new McpError(
                BaseErrorCode.NOT_FOUND, 
                errorMessage, 
                { url, statusCode: response.status, topic }
              );
            case 429:
              errorMessage = 'Too many requests: rate limit exceeded';
              throw new McpError(
                BaseErrorCode.RATE_LIMITED, 
                errorMessage, 
                { url, statusCode: response.status }
              );
            case 500:
            case 502:
            case 503:
            case 504:
              errorMessage = `Server error: ${response.statusText}`;
              // Fall through to default error handling
            default:
              throw new NtfyConnectionError(errorMessage, url);
          }
        }

        // Parse response
        const result = await response.json();
        
        publisherLogger.info('Message published successfully', { 
          messageId: result.id,
          topic: result.topic,
          requestId: requestCtx.requestId
        });
        
        return result as NtfyPublishResponse;
      } catch (error) {
        clearTimeout(timeoutId);
        
        if (error instanceof NtfyInvalidTopicError) {
          throw error;
        }

        publisherLogger.error('Failed to publish message', {
          error: error instanceof Error ? error.message : String(error),
          topic,
          url,
          requestId: requestCtx.requestId
        });

        throw new NtfyConnectionError(
          `Error publishing to topic: ${error instanceof Error ? error.message : String(error)}`,
          url
        );
      }
    },
    {
      operation: 'publishNtfyMessage',
      context: { topic },
      input: {
        message: message?.length > 100 ? `${message.substring(0, 100)}...` : message,
        options: sanitizeInputForLogging(options)
      },
      errorCode: BaseErrorCode.SERVICE_UNAVAILABLE,
      errorMapper: ntfyErrorMapper,
      rethrow: true
    }
  );
}
