#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { config } from "../config/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import { ErrorHandler } from "../utils/errorHandler.js";
import { idGenerator } from "../utils/idGenerator.js";
import { logger, ChildLogger } from "../utils/logger.js";
import { createRequestContext } from "../utils/requestContext.js";
import { configureContext, sanitizeInput } from "../utils/security.js";

// Calculate __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import tool and resource registrations
import { registerNtfyTool } from "./tools/ntfyTool/index.js";
import { registerNtfyResource } from "./resources/ntfyResource/index.js";

// Maximum file size for package.json (5MB) to prevent potential DoS
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Load package information directly from package.json
 * 
 * @param logger - The logger instance to use for logging
 * @returns A promise resolving to an object with the package name and version
 */
const loadPackageInfo = async (loggerInstance?: ChildLogger): Promise<{ name: string; version: string }> => {
  const pkgLogger = loggerInstance || logger.createChildLogger({ module: 'PackageInfo' });
  
  return await ErrorHandler.tryCatch(
    async () => {
      // Use the globally defined __dirname from the top of the file
      const pkgPath = path.resolve(__dirname, '../../package.json');
      const safePath = sanitizeInput.path(pkgPath, { allowAbsolute: true });
      
      pkgLogger.debug(`Looking for package.json at: ${safePath}`);
      
      // Get file stats to check size before reading
      const stats = await fs.stat(safePath);
      
      // Check file size to prevent DoS attacks
      if (stats.size > MAX_FILE_SIZE) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          `package.json file is too large (${stats.size} bytes)`,
          { path: safePath, maxSize: MAX_FILE_SIZE }
        );
      }
      
      const pkgContent = await fs.readFile(safePath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      
      if (!pkg.name || typeof pkg.name !== 'string' || 
          !pkg.version || typeof pkg.version !== 'string') {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR, 
          'Invalid package.json: missing name or version',
          { path: safePath }
        );
      }
      
      return {
        name: pkg.name,
        version: pkg.version
      };
    },
    {
      operation: 'LoadPackageInfo',
      errorCode: BaseErrorCode.VALIDATION_ERROR,
      rethrow: true, // Changed to true so errors propagate
      includeStack: true,
      errorMapper: (error) => {
        if (error instanceof SyntaxError) {
          return new McpError(
            BaseErrorCode.VALIDATION_ERROR,
            `Failed to parse package.json: ${error.message}`,
            { errorType: 'SyntaxError' }
          );
        }
        return new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          `Failed to load package info: ${error instanceof Error ? error.message : String(error)}`,
          { errorType: error instanceof Error ? error.name : typeof error }
        );
      }
    }
  );
};

/**
 * Server state management interface
 */
export interface ServerState {
  status: 'initializing' | 'running' | 'error' | 'degraded' | 'shutting_down' | 'shutdown';
  startTime: Date;
  lastHealthCheck: Date;
  activeOperations: Map<string, { operation: string; startTime: Date }>;
  errors: Array<{ timestamp: Date; message: string; code?: string }>;
  registeredTools: Set<string>;
  registeredResources: Set<string>;
  failedRegistrations: Array<{
    type: 'tool' | 'resource';
    name: string;
    error: any; // Ensure error is always present
    attempts: number; // Track attempts if retry logic is added
  }>;
  requiredTools: Set<string>; // Tools essential for basic functionality
  requiredResources: Set<string>; // Resources essential for basic functionality
}

/**
 * Server event emitter for lifecycle events
 */
class ServerEvents extends EventEmitter {
  constructor() {
    super();
  }

  // Type-safe event emitters
  emitStateChange(oldState: ServerState['status'], newState: ServerState['status']) {
    this.emit('stateChange', oldState, newState);
    this.emit(`state:${newState}`, oldState);
  }
}

/**
 * Create and initialize an MCP server instance with all tools and resources
 * 
 * This function configures the MCP server with security settings, tools, and resources.
 * It connects the server to a transport (currently stdio) and returns the initialized
 * server instance.
 * 
 * @returns A promise that resolves to the initialized McpServer instance
 * @throws {McpError} If the server fails to initialize
 */
export const createMcpServer = async () => {
  // Initialize server variable outside try/catch
  let server: McpServer | undefined;
  
  // Maximum registration retry attempts (currently not implemented, but placeholder)
  const MAX_REGISTRATION_RETRIES = 1; 
  
  // Create a unique server instance ID
  const serverId = idGenerator.generateRandomString(8);
  
  // Initialize server state for tracking
  const serverState: ServerState = {
    status: 'initializing',
    startTime: new Date(),
    lastHealthCheck: new Date(),
    activeOperations: new Map(),
    errors: [],
    registeredTools: new Set(),
    registeredResources: new Set(),
    failedRegistrations: [],
    requiredTools: new Set(['send_ntfy']), // Define tools that are required for the server to function properly
    requiredResources: new Set([]) // Define resources that are required for the server to function properly
  };

  // Create operation context
  const serverContext = createRequestContext({
    operation: 'ServerStartup',
    component: 'McpServer',
    serverId
  });

  // Create server-specific logger with context
  const serverLogger = logger.createChildLogger({
    module: 'MCPServer',
    service: 'MCPServer',
    requestId: serverContext.requestId,
    serverId,
    environment: config.environment
  });

  // Create server events emitter
  const serverEvents = new ServerEvents();
  
  // Monitor state changes
  serverEvents.on('stateChange', (oldState, newState) => {
    serverLogger.info(`Server state changed from ${oldState} to ${newState}`, { 
      previousState: oldState, 
      newState 
    });
  });
  
  serverLogger.info("Initializing server...");
  
  const timers: Array<NodeJS.Timeout> = [];
  
  return await ErrorHandler.tryCatch(
    async () => {
      // Load package info asynchronously
      const packageInfo = await loadPackageInfo(serverLogger);
      
      // Update logger with package info
      serverLogger.info("Loaded package info", {
        name: packageInfo.name,
        version: packageInfo.version
      });

      // Create the MCP server instance
      serverLogger.debug("Creating MCP server instance...");
      server = new McpServer({
        name: packageInfo.name,
        version: packageInfo.version
      });
      serverLogger.debug("MCP server instance created");
      
      // Register tools and resources in parallel with error handling
      type RegistrationResult = {
        success: boolean;
        type: 'tool' | 'resource';
        name: string;
        error?: any; // Error is optional here as success=true means no error
      };
      
      const registerComponent = async (
        type: 'tool' | 'resource',
        name: string,
        registerFn: () => Promise<void>
      ): Promise<RegistrationResult> => {
        serverLogger.debug(`Registering ${type}: ${name}`);
        try {
          await ErrorHandler.tryCatch(
            async () => await registerFn(),
            {
              operation: `Register${type === 'tool' ? 'Tool' : 'Resource'}`,
              context: { ...serverContext, componentName: name },
              errorCode: BaseErrorCode.INTERNAL_ERROR
            }
          );
          
          // Update state based on component type
          if (type === 'tool') {
            serverState.registeredTools.add(name);
          } else {
            serverState.registeredResources.add(name);
          }
          
          serverLogger.debug(`Successfully registered ${type}: ${name}`);
          return { success: true, type, name }; // No error on success
        } catch (error) {
          serverLogger.error(`Failed to register ${type}: ${name}`, { error });
          return { success: false, type, name, error }; // Error included on failure
        }
      };
      
      // Register components with proper error handling
      serverLogger.debug("Registering components...");
      const registrationPromises: Promise<RegistrationResult>[] = [
        registerComponent('tool', 'send_ntfy', () => registerNtfyTool(server!)),
        registerComponent('resource', 'ntfy-resource', () => registerNtfyResource(server!)),
      ];
      
      const registrationResults = await Promise.allSettled(registrationPromises);
      
      // Process the results to find failed registrations
      let hasRequiredFailure = false;
      registrationResults.forEach(result => {
        if (result.status === 'rejected') {
          // This indicates an unexpected error during the registerComponent wrapper itself
          const failure = { 
            type: 'unknown' as 'tool' | 'resource', 
            name: 'unknown', 
            error: result.reason ?? new Error('Unknown registration wrapper error'), // Ensure error exists
            attempts: 1 // Assuming 1 attempt for now
          };
          serverState.failedRegistrations.push(failure);
          serverLogger.error("Unexpected error during component registration wrapper", { failure });
          // Assume any unknown failure could be critical
          hasRequiredFailure = true; 
        } else if (!result.value.success) {
          // This indicates a failure within the specific registerFn (result.value.error should exist)
          const failure = { 
            type: result.value.type,
            name: result.value.name,
            // Provide a fallback error just in case, though logic implies error exists
            error: result.value.error ?? new Error(`Unknown error registering ${result.value.type} ${result.value.name}`), 
            attempts: 1 // Assuming 1 attempt for now
          };
          serverState.failedRegistrations.push(failure);
          serverLogger.warn(`Registration failed for ${failure.type}: ${failure.name}`, { error: failure.error });
          
          // Check if the failed component was required
          if ((failure.type === 'tool' && serverState.requiredTools.has(failure.name)) ||
              (failure.type === 'resource' && serverState.requiredResources.has(failure.name))) {
            serverLogger.error(`Required ${failure.type} '${failure.name}' failed to register. Server will be degraded.`, { error: failure.error });
            hasRequiredFailure = true;
          }
        }
      });
      
      // Update server status based on registration results
      const previousStatus = serverState.status;
      if (hasRequiredFailure) {
        serverState.status = 'degraded';
      } else {
        serverState.status = 'running'; // Move to running only if all required components registered
      }
      
      // Emit state change if status updated
      if (serverState.status !== previousStatus) {
        serverEvents.emitStateChange(previousStatus, serverState.status);
      }

      serverLogger.info(`Component registration complete. Status: ${serverState.status}`, {
        registeredTools: Array.from(serverState.registeredTools),
        registeredResources: Array.from(serverState.registeredResources),
        failedCount: serverState.failedRegistrations.length,
        failedComponents: serverState.failedRegistrations.map(f => `${f.type}:${f.name}`)
      });

      // Add debug logs to diagnose the connection issue
      serverLogger.debug("About to connect to stdio transport");
      
      try {
        // Connect using stdio transport
        const transport = new StdioServerTransport();
        serverLogger.debug("Created StdioServerTransport instance");
        
        // Set event handlers
        // Using 'as any' for onerror as the type might not be directly exposed or stable in the SDK.
        // This bypasses TypeScript checks but allows attaching the handler.
        // TODO: Revisit if future SDK versions provide a type-safe way to attach error handlers.
        (server as any).onerror = (err: Error) => {
          serverLogger.error(`Server transport error: ${err.message}`, { stack: err.stack });
          // Optionally update server state on transport errors
          if (serverState.status !== 'error' && serverState.status !== 'shutting_down') {
             const oldStatus = serverState.status;
             serverState.status = 'error';
             serverEvents.emitStateChange(oldStatus, 'error');
          }
          serverState.errors.push({ timestamp: new Date(), message: err.message, code: 'TRANSPORT_ERROR' });
        };
        
        // Skip setting onrequest since we don't have access to the type
        
        await server.connect(transport);
        serverLogger.debug("Connected to transport successfully");
      } catch (error) {
        serverLogger.error("Error connecting to transport", { 
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        // Update state on connection failure
        const oldStatus = serverState.status;
        serverState.status = 'error';
        serverEvents.emitStateChange(oldStatus, 'error');
        throw error; // Re-throw connection error
      }
      
      serverLogger.info("MCP server initialized and connected");
      return server;
    },
    {
      operation: 'CreateMcpServer',
      context: serverContext,
      critical: true,
      errorMapper: (error) => new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        `Failed to initialize MCP server: ${error instanceof Error ? error.message : String(error)}`,
        { 
          serverState: serverState.status,
          startTime: serverState.startTime,
          registeredTools: Array.from(serverState.registeredTools),
          registeredResources: Array.from(serverState.registeredResources)
        }
      )
    }
  ).catch((error) => {
    serverLogger.error("Fatal error in MCP server creation", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Attempt to close server
    if (server) {
      try {
        server.close();
      } catch (closeError) {
        // Already in error state, just log
        serverLogger.error("Error while closing server during error recovery", {
          error: closeError instanceof Error ? closeError.message : String(closeError),
          stack: closeError instanceof Error ? closeError.stack : undefined
        });
      }
    }
    
    // Re-throw to communicate error to caller
    throw error;
  });
};
