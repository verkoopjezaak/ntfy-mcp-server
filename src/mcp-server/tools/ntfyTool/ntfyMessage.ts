import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { ErrorHandler } from "../../../utils/errorHandler.js";
import { publish, NtfyPublishOptions, NtfyPriority, validateTopicSync } from "../../../services/ntfy/index.js";
import { config } from "../../../config/index.js";
import { SendNtfyToolInput, SendNtfyToolResponse, createSendNtfyToolSchema } from "./types.js";
import { logger } from "../../../utils/logger.js";
import { createRequestContext } from "../../../utils/requestContext.js";
import { sanitizeInput, sanitizeInputForLogging } from "../../../utils/sanitization.js";
import { idGenerator } from "../../../utils/idGenerator.js";
import { RateLimiter } from "../../../utils/rateLimiter.js";

// Create a module-specific logger
const ntfyToolLogger = logger.createChildLogger({ 
  module: 'NtfyTool',
  serviceId: idGenerator.generateRandomString(8)
});

// Create rate limiters for global and per-topic usage
const rateLimit = config.rateLimit;
const globalRateLimiter = new RateLimiter({
  windowMs: rateLimit.windowMs,
  maxRequests: rateLimit.maxRequests,
  errorMessage: 'Global rate limit exceeded for ntfy notifications. Please try again in {waitTime} seconds.',
});

// Map to cache per-topic rate limiters
const topicRateLimiters = new Map<string, RateLimiter>();
const MAX_CACHED_TOPIC_LIMITERS = 1000; // Limit the cache size

/**
 * Gets or creates a rate limiter for a specific topic, with cache cleanup.
 * 
 * @param topic - The ntfy topic
 * @returns Rate limiter instance for the topic
 */
function getTopicRateLimiter(topic: string): RateLimiter {
  const normalizedTopic = topic.toLowerCase().trim();
  
  if (!topicRateLimiters.has(normalizedTopic)) {
    // Check cache size before adding a new limiter
    if (topicRateLimiters.size >= MAX_CACHED_TOPIC_LIMITERS) {
      // Remove the oldest entry (first key in insertion order)
      const oldestTopic = topicRateLimiters.keys().next().value;
      if (oldestTopic) {
        topicRateLimiters.delete(oldestTopic);
        ntfyToolLogger.debug(`Removed oldest topic rate limiter due to cache size limit: ${oldestTopic}`, {
          cacheSize: topicRateLimiters.size,
          limit: MAX_CACHED_TOPIC_LIMITERS
        });
      }
    }

    // Make per-topic limit more restrictive than global
    const perTopicLimit = Math.min(50, Math.floor(rateLimit.maxRequests / 2));
    
    topicRateLimiters.set(normalizedTopic, new RateLimiter({
      windowMs: rateLimit.windowMs,
      maxRequests: perTopicLimit,
      errorMessage: `Rate limit exceeded for topic '${normalizedTopic}'. Please try again in {waitTime} seconds.`,
    }));
    ntfyToolLogger.debug(`Created new rate limiter for topic: ${normalizedTopic}`, {
      cacheSize: topicRateLimiters.size
    });
  }
  
  return topicRateLimiters.get(normalizedTopic)!;
}

/**
 * Process and send a notification via ntfy
 * Includes rate limiting, message validation, and retry logic
 * 
 * @param params - Parameters for the ntfy message
 * @returns Response with notification details
 */
export const processNtfyMessage = async (
  params: SendNtfyToolInput
): Promise<SendNtfyToolResponse> => {
  return ErrorHandler.tryCatch(
    async () => {
      // Create request context for tracking
      const requestCtx = createRequestContext({
        operation: 'processNtfyMessage',
        messageId: idGenerator.generateRandomString(8),
        hasTitle: !!params.title,
        hasTags: !!params.tags && params.tags.length > 0,
        priority: params.priority,
        topic: params.topic
      });

      // Extract the necessary parameters
      const { topic, message, ...options } = params;
      
      ntfyToolLogger.info('Processing ntfy message request', {
        topic,
        hasTags: !!options.tags && options.tags.length > 0,
        hasTitle: !!options.title,
        messageLength: message?.length,
        requestId: requestCtx.requestId
      });
      
      // Get the ntfy config
      const ntfyConfig = config.ntfy;
      
      // Use default topic from env if not provided
      const finalTopic = topic || ntfyConfig.defaultTopic;
      
      // Log the topic resolution (more visible INFO level)
      ntfyToolLogger.info('Topic resolution', {
        providedTopic: topic || '(not provided)',
        defaultTopic: ntfyConfig.defaultTopic || '(not configured)',
        finalTopic: finalTopic || '(none)',
        requestId: requestCtx.requestId
      });
      
      // Validate topic is present
      if (!finalTopic) {
        ntfyToolLogger.error('Topic validation failed - missing topic', {
          requestId: requestCtx.requestId
        });
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Topic is required and no default topic is configured in the environment"
        );
      }

      // Additional topic validation using our utility
      if (!validateTopicSync(finalTopic)) {
        ntfyToolLogger.error('Topic validation failed - invalid topic format', {
          topic: finalTopic,
          requestId: requestCtx.requestId
        });
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Invalid topic format. Topics must be non-empty and cannot contain newlines"
        );
      }
      
      // Apply rate limiting (both global and per-topic)
      try {
        // Check global rate limit first
        globalRateLimiter.check('global');
        
        // Then check per-topic rate limit
        getTopicRateLimiter(finalTopic).check(finalTopic);
      } catch (error) {
        if (error instanceof McpError && error.code === BaseErrorCode.RATE_LIMITED) {
          ntfyToolLogger.warn('Rate limit exceeded', {
            requestId: requestCtx.requestId,
            topic: finalTopic,
            error: error.message
          });
        }
        // Always throw rate limit errors
        throw error;
      }
      
      // Message size validation
      const messageSize = Buffer.byteLength(message, 'utf8');
      const maxSize = ntfyConfig.maxMessageSize || 4096;
      if (messageSize > maxSize) {
        ntfyToolLogger.error('Message size validation failed', {
          messageSize,
          maxSize,
          requestId: requestCtx.requestId
        });
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          `Message size (${messageSize} bytes) exceeds maximum allowed size (${maxSize} bytes)`
        );
      }
      
      // Prepare sanitized publish options
      const publishOptions: NtfyPublishOptions = {
        // Message metadata
        title: options.title ? sanitizeInput.string(options.title) : undefined,
        tags: options.tags?.map(tag => sanitizeInput.string(tag)),
        priority: options.priority as NtfyPriority | undefined,
        markdown: options.markdown,
        
        // Interactive elements
        click: options.click ? sanitizeInput.url(options.click) : undefined,
        actions: options.actions?.map(action => ({
          id: sanitizeInput.string(action.id),
          label: sanitizeInput.string(action.label),
          action: sanitizeInput.string(action.action),
          url: action.url ? sanitizeInput.url(action.url) : undefined,
          method: action.method ? sanitizeInput.string(action.method) : undefined,
          // TODO: Review if action.headers need sanitization/validation based on ntfy processing.
          // Currently passed through as-is.
          headers: action.headers, 
          body: action.body ? sanitizeInput.string(action.body) : undefined,
          clear: action.clear
        })),
        
        // Media and attachments
        attachment: options.attachment && {
          url: sanitizeInput.url(options.attachment.url),
          name: options.attachment.name 
            ? sanitizeInput.string(options.attachment.name) 
            : sanitizeInput.string(options.attachment.url.split('/').pop() || 'attachment')
        },
        
        // Delivery options
        email: options.email ? sanitizeInput.string(options.email) : undefined,
        delay: options.delay ? sanitizeInput.string(options.delay) : undefined,
        cache: options.cache ? sanitizeInput.string(options.cache) : undefined,
        firebase: options.firebase ? sanitizeInput.string(options.firebase) : undefined,
        expires: options.expires ? sanitizeInput.string(options.expires) : undefined,
        id: options.id ? sanitizeInput.string(options.id) : undefined,
        
        // Server configuration
        baseUrl: options.baseUrl ? sanitizeInput.url(options.baseUrl) : ntfyConfig.baseUrl,
      };
      
      ntfyToolLogger.debug('Prepared publish options', {
        topic: finalTopic,
        hasTitle: !!publishOptions.title,
        hasTags: !!publishOptions.tags && publishOptions.tags.length > 0,
        baseUrl: publishOptions.baseUrl,
        messageSize,
        requestId: requestCtx.requestId
      });
      
      // Set authentication if API key or basic auth credentials are available
      if (ntfyConfig.apiKey) {
        publishOptions.auth = ntfyConfig.apiKey;
      } else if (ntfyConfig.username && ntfyConfig.password) {
        publishOptions.username = ntfyConfig.username;
        publishOptions.password = ntfyConfig.password;
      }

      ntfyToolLogger.debug('Authentication configured', {
        hasAuth: !!publishOptions.auth,
        hasBasicAuth: !!(ntfyConfig.username && ntfyConfig.password),
        apiKeyAvailable: !!ntfyConfig.apiKey,
        requestId: requestCtx.requestId
      });
      
      ntfyToolLogger.debug('Publishing with options', {
        topic: finalTopic,
        messageSize,
        hasAuth: !!publishOptions.auth,
        hasTitle: !!publishOptions.title,
        hasTags: !!publishOptions.tags,
        requestId: requestCtx.requestId
      });
      
      // Send with retry logic
      const maxRetries = ntfyConfig.maxRetries || 3;
      let retries = 0;
      let result;
      
      for (retries = 0; retries <= maxRetries; retries++) {
        try {
          // Apply exponential backoff for retries
          if (retries > 0) {
            const backoffMs = Math.min(100 * Math.pow(2, retries), 2000);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            
            ntfyToolLogger.info(`Retry attempt ${retries}/${maxRetries}`, {
              topic: finalTopic,
              requestId: requestCtx.requestId
            });
          }
          
          ntfyToolLogger.info(`Sending notification${retries > 0 ? ' (retry)' : ''}`, {
            topic: finalTopic,
            messageLength: messageSize,
            retry: retries,
            requestId: requestCtx.requestId
          });
          
          // Publish the message
          result = await publish(finalTopic, message, publishOptions);
          
          ntfyToolLogger.info('Notification sent successfully', {
            messageId: result.id,
            topic: result.topic,
            retries,
            requestId: requestCtx.requestId
          });
          
          // Success - exit retry loop
          break;
          
        } catch (error) {
          // Determine if error is retriable
          const errorMsg = error instanceof Error ? error.message.toLowerCase() : '';
          const isNetworkError = 
            errorMsg.includes('network') || 
            errorMsg.includes('timeout') || 
            errorMsg.includes('connection') ||
            errorMsg.includes('econnrefused') || 
            errorMsg.includes('econnreset');
          
          if (!isNetworkError || retries >= maxRetries) {
            ntfyToolLogger.error('Failed to send notification, giving up', {
              topic: finalTopic,
              error: error instanceof Error ? error.message : String(error),
              retries,
              requestId: requestCtx.requestId
            });
            throw error;
          }
          
          ntfyToolLogger.warn('Notification failed, will retry', {
            topic: finalTopic,
            error: error instanceof Error ? error.message : String(error),
            retryCount: retries,
            nextRetry: retries + 1,
            requestId: requestCtx.requestId
          });
        }
      }
      
      // Verify we have a result
      if (!result) {
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          `Failed to send notification after ${maxRetries} retries`
        );
      }
      
      // Return the response
      return {
        success: true,
        id: result.id,
        topic: result.topic,
        time: result.time,
        expires: result.expires,
        message: message,
        title: options.title,
        url: options.click,
        retries: retries > 0 ? retries : undefined
      };
    },
    {
      operation: 'processNtfyMessage',
      context: { 
        topic: params.topic || config.ntfy.defaultTopic,
        hasTitle: !!params.title
      },
      input: sanitizeInputForLogging(params),
      errorCode: BaseErrorCode.SERVICE_UNAVAILABLE,
      errorMapper: (error) => {
        if (error instanceof McpError) {
          return error;
        }
        
        // Map common errors to more specific error codes
        if (error instanceof Error) {
          const errorMsg = error.message.toLowerCase();
          
          if (errorMsg.includes('rate limit') || errorMsg.includes('too many requests')) {
            return new McpError(
              BaseErrorCode.RATE_LIMITED,
              `Rate limit exceeded: ${error.message}`
            );
          }
          
          if (errorMsg.includes('timeout')) {
            return new McpError(
              BaseErrorCode.TIMEOUT,
              `Request timed out: ${error.message}`
            );
          }
          
          if (errorMsg.includes('validation') || errorMsg.includes('invalid')) {
            return new McpError(
              BaseErrorCode.VALIDATION_ERROR,
              `Validation error: ${error.message}`
            );
          }
        }
        
        return new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE,
          `Failed to send ntfy notification: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      },
      rethrow: true
    }
  );
};
