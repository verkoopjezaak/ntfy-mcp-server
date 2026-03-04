import dotenv from 'dotenv';
import path from 'path';
import { createRequestContext } from '../utils/requestContext.js';
import { logger } from '../utils/logger.js';

// Initialize environment variables from .env file
dotenv.config();

// Create a request context for logging
const configContext = createRequestContext({
  operation: 'ConfigInit',
  component: 'Config',
});

// Create a logger specific to config
const configLogger = logger.createChildLogger({
  module: 'Config',
  service: 'Config',
  requestId: configContext.requestId,
});

/**
 * Environment validation and parsing utilities
 */
const parsers = {
  /**
   * Parse environment string to number with validation
   * 
   * @param value - String value from environment
   * @param defaultValue - Default value to use if parsing fails
   * @returns Parsed number value
   */
  number: (value: string | undefined, defaultValue: number): number => {
    if (!value) return defaultValue;
    
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      configLogger.warn(`Invalid number for environment variable, using default: ${defaultValue}`, {
        value,
        defaultValue
      });
      return defaultValue;
    }
    
    return parsed;
  },
  
  /**
   * Parse environment string to boolean
   * 
   * @param value - String value from environment
   * @param defaultValue - Default value to use if parsing fails
   * @returns Parsed boolean value
   */
  boolean: (value: string | undefined, defaultValue: boolean): boolean => {
    if (!value) return defaultValue;
    
    const normalized = value.toLowerCase().trim();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    
    configLogger.warn(`Invalid boolean for environment variable, using default: ${defaultValue}`, {
      value,
      defaultValue
    });
    return defaultValue;
  },
  
  /**
   * Parse environment string to an array of strings
   * 
   * @param value - Comma-separated string value from environment
   * @param defaultValue - Default value to use if parsing fails
   * @returns Array of parsed string values
   */
  array: (value: string | undefined, defaultValue: string[] = []): string[] => {
    if (!value) return defaultValue;
    
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
};

/**
 * Environment variable configuration
 */
export const config = {
  environment: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // HTTP server configuration
  server: {
    port: parsers.number(process.env.PORT, 3000),
    host: process.env.HOST || 'localhost',
  },
  
  // Rate limiting settings
  rateLimit: {
    windowMs: parsers.number(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    maxRequests: parsers.number(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
  },
  
  // Ntfy notification service configuration
  ntfy: {
    baseUrl: process.env.NTFY_BASE_URL || 'https://ntfy.sh',
    defaultTopic: process.env.NTFY_DEFAULT_TOPIC || '',
    apiKey: process.env.NTFY_API_KEY || '',
    username: process.env.NTFY_USERNAME || '',
    password: process.env.NTFY_PASSWORD || '',
    maxMessageSize: parsers.number(process.env.NTFY_MAX_MESSAGE_SIZE, 4096),
    maxRetries: parsers.number(process.env.NTFY_MAX_RETRIES, 3),
  },
};

// Log the loaded configuration (excluding sensitive values)
configLogger.info('Configuration loaded', {
  environment: config.environment,
  logLevel: config.logLevel,
  server: { host: config.server.host }, // Log only host, not port
  ntfy: {
    baseUrl: config.ntfy.baseUrl,
    defaultTopic: config.ntfy.defaultTopic || '(not set)',
    hasApiKey: !!config.ntfy.apiKey,
  },
});

export default config;
