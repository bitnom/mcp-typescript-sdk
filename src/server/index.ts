import z, { AnyZodObject, ZodRawShape, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  mergeCapabilities,
  Protocol,
  ProtocolOptions,
  RequestHandlerExtra,
  RequestOptions,
} from "../shared/protocol.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResultSchema,
  EmptyResultSchema,
  ErrorCode,
  Implementation,
  InitializedNotificationSchema,
  InitializeRequest,
  InitializeRequestSchema,
  InitializeResult,
  LATEST_PROTOCOL_VERSION,
  ListResourcesRequestSchema,
  ListResourcesResult,
  ListResourceTemplatesRequestSchema,
  ListRootsRequest,
  ListRootsResultSchema,
  ListToolsRequestSchema,
  ListToolsResult,
  LoggingMessageNotification,
  McpError,
  Notification,
  ReadResourceRequestSchema,
  ReadResourceResult,
  Request,
  Resource,
  ResourceUpdatedNotification,
  Result,
  ServerCapabilities,
  ServerNotification,
  ServerRequest,
  ServerResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  Tool,
} from "../types.js";
import { UriTemplate, Variables } from "../shared/uriTemplate.js";

export type ServerOptions = ProtocolOptions & {
  /**
   * Capabilities to advertise as being supported by this server.
   */
  capabilities?: ServerCapabilities;
};

/**
 * Callback for a tool handler registered with Server.tool().
 *
 * Parameters will include tool arguments, if applicable, as well as other request handler context.
 */
export type ToolCallback<Args extends undefined | ZodRawShape = undefined> =
  Args extends ZodRawShape
    ? (
        args: z.objectOutputType<Args, ZodTypeAny>,
        extra: RequestHandlerExtra,
      ) => CallToolResult | Promise<CallToolResult>
    : (extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>;

type RegisteredTool = {
  description?: string;
  inputSchema?: AnyZodObject;
  callback: ToolCallback<undefined | ZodRawShape>;
};

const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object" as const,
};

export type ResourceMetadata = Omit<Resource, "uri" | "name">;

export type ReadResourceCallback = (
  uri: URL,
  variables?: Variables,
) => ReadResourceResult | Promise<ReadResourceResult>;

export type ListResourcesCallback = () =>
  | ListResourcesResult
  | Promise<ListResourcesResult>;

type RegisteredResource = {
  name: string;
  metadata?: ResourceMetadata;
  readCallback: ReadResourceCallback;
};

type RegisteredResourceTemplate = {
  uriTemplate: UriTemplate;
  metadata?: ResourceMetadata;
  listCallback?: ListResourcesCallback;
  readCallback: ReadResourceCallback;
};

/**
 * An MCP server on top of a pluggable transport.
 *
 * This server will automatically respond to the initialization flow as initiated from the client.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed server
 * const server = new Server<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomServer",
 *   version: "1.0.0"
 * })
 * ```
 */
export class Server<
  RequestT extends Request = Request,
  NotificationT extends Notification = Notification,
  ResultT extends Result = Result,
> extends Protocol<
  ServerRequest | RequestT,
  ServerNotification | NotificationT,
  ServerResult | ResultT
> {
  private _clientCapabilities?: ClientCapabilities;
  private _clientVersion?: Implementation;
  private _capabilities: ServerCapabilities;
  private _registeredTools: { [name: string]: RegisteredTool } = {};
  private _registeredResources: { [uri: string]: RegisteredResource } = {};
  private _registeredResourceTemplates: {
    [name: string]: RegisteredResourceTemplate;
  } = {};

  /**
   * Callback for when initialization has fully completed (i.e., the client has sent an `initialized` notification).
   */
  oninitialized?: () => void;

  /**
   * Initializes this server with the given name and version information.
   */
  constructor(
    private _serverInfo: Implementation,
    options?: ServerOptions,
  ) {
    super(options);
    this._capabilities = options?.capabilities ?? {};

    this.setRequestHandler(InitializeRequestSchema, (request) =>
      this._oninitialize(request),
    );
    this.setNotificationHandler(InitializedNotificationSchema, () =>
      this.oninitialized?.(),
    );
  }

  /**
   * Registers new capabilities. This can only be called before connecting to a transport.
   *
   * The new capabilities will be merged with any existing capabilities previously given (e.g., at initialization).
   */
  public registerCapabilities(capabilities: ServerCapabilities): void {
    if (this.transport) {
      throw new Error(
        "Cannot register capabilities after connecting to transport",
      );
    }

    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }

  protected assertCapabilityForMethod(method: RequestT["method"]): void {
    switch (method as ServerRequest["method"]) {
      case "sampling/createMessage":
        if (!this._clientCapabilities?.sampling) {
          throw new Error(
            `Client does not support sampling (required for ${method})`,
          );
        }
        break;

      case "roots/list":
        if (!this._clientCapabilities?.roots) {
          throw new Error(
            `Client does not support listing roots (required for ${method})`,
          );
        }
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  protected assertNotificationCapability(
    method: (ServerNotification | NotificationT)["method"],
  ): void {
    switch (method as ServerNotification["method"]) {
      case "notifications/message":
        if (!this._capabilities.logging) {
          throw new Error(
            `Server does not support logging (required for ${method})`,
          );
        }
        break;

      case "notifications/resources/updated":
      case "notifications/resources/list_changed":
        if (!this._capabilities.resources) {
          throw new Error(
            `Server does not support notifying about resources (required for ${method})`,
          );
        }
        break;

      case "notifications/tools/list_changed":
        if (!this._capabilities.tools) {
          throw new Error(
            `Server does not support notifying of tool list changes (required for ${method})`,
          );
        }
        break;

      case "notifications/prompts/list_changed":
        if (!this._capabilities.prompts) {
          throw new Error(
            `Server does not support notifying of prompt list changes (required for ${method})`,
          );
        }
        break;

      case "notifications/cancelled":
        // Cancellation notifications are always allowed
        break;

      case "notifications/progress":
        // Progress notifications are always allowed
        break;
    }
  }

  protected assertRequestHandlerCapability(method: string): void {
    switch (method) {
      case "sampling/createMessage":
        if (!this._capabilities.sampling) {
          throw new Error(
            `Server does not support sampling (required for ${method})`,
          );
        }
        break;

      case "logging/setLevel":
        if (!this._capabilities.logging) {
          throw new Error(
            `Server does not support logging (required for ${method})`,
          );
        }
        break;

      case "prompts/get":
      case "prompts/list":
        if (!this._capabilities.prompts) {
          throw new Error(
            `Server does not support prompts (required for ${method})`,
          );
        }
        break;

      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
        if (!this._capabilities.resources) {
          throw new Error(
            `Server does not support resources (required for ${method})`,
          );
        }
        break;

      case "tools/call":
      case "tools/list":
        if (!this._capabilities.tools) {
          throw new Error(
            `Server does not support tools (required for ${method})`,
          );
        }
        break;

      case "ping":
      case "initialize":
        // No specific capability required for these methods
        break;
    }
  }

  private async _oninitialize(
    request: InitializeRequest,
  ): Promise<InitializeResult> {
    const requestedVersion = request.params.protocolVersion;

    this._clientCapabilities = request.params.capabilities;
    this._clientVersion = request.params.clientInfo;

    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : LATEST_PROTOCOL_VERSION,
      capabilities: this.getCapabilities(),
      serverInfo: this._serverInfo,
    };
  }

  /**
   * After initialization has completed, this will be populated with the client's reported capabilities.
   */
  getClientCapabilities(): ClientCapabilities | undefined {
    return this._clientCapabilities;
  }

  /**
   * After initialization has completed, this will be populated with information about the client's name and version.
   */
  getClientVersion(): Implementation | undefined {
    return this._clientVersion;
  }

  private getCapabilities(): ServerCapabilities {
    return this._capabilities;
  }

  async ping() {
    return this.request({ method: "ping" }, EmptyResultSchema);
  }

  async createMessage(
    params: CreateMessageRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "sampling/createMessage", params },
      CreateMessageResultSchema,
      options,
    );
  }

  async listRoots(
    params?: ListRootsRequest["params"],
    options?: RequestOptions,
  ) {
    return this.request(
      { method: "roots/list", params },
      ListRootsResultSchema,
      options,
    );
  }

  async sendLoggingMessage(params: LoggingMessageNotification["params"]) {
    return this.notification({ method: "notifications/message", params });
  }

  async sendResourceUpdated(params: ResourceUpdatedNotification["params"]) {
    return this.notification({
      method: "notifications/resources/updated",
      params,
    });
  }

  async sendResourceListChanged() {
    return this.notification({
      method: "notifications/resources/list_changed",
    });
  }

  async sendToolListChanged() {
    return this.notification({ method: "notifications/tools/list_changed" });
  }

  async sendPromptListChanged() {
    return this.notification({ method: "notifications/prompts/list_changed" });
  }

  private setToolRequestHandlers() {
    this.assertCanSetRequestHandler(ListToolsRequestSchema.shape.method.value);
    this.assertCanSetRequestHandler(CallToolRequestSchema.shape.method.value);

    this.registerCapabilities({
      tools: {},
    });

    this.setRequestHandler(
      ListToolsRequestSchema,
      (): ListToolsResult => ({
        tools: Object.entries(this._registeredTools).map(
          ([name, tool]): Tool => {
            return {
              name,
              description: tool.description,
              inputSchema: tool.inputSchema
                ? (zodToJsonSchema(tool.inputSchema) as Tool["inputSchema"])
                : EMPTY_OBJECT_JSON_SCHEMA,
            };
          },
        ),
      }),
    );

    this.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        const tool = this._registeredTools[request.params.name];
        if (!tool) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Tool ${request.params.name} not found`,
          );
        }

        if (tool.inputSchema) {
          const parseResult = await tool.inputSchema.safeParseAsync(
            request.params.arguments,
          );
          if (!parseResult.success) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid arguments for tool ${request.params.name}: ${parseResult.error.message}`,
            );
          }

          const args = parseResult.data;
          const cb = tool.callback as ToolCallback<ZodRawShape>;
          try {
            return await Promise.resolve(cb(args, extra));
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            };
          }
        } else {
          const cb = tool.callback as ToolCallback<undefined>;
          try {
            return await Promise.resolve(cb(extra));
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            };
          }
        }
      },
    );
  }

  /**
   * Registers a zero-argument tool `name`, which will run the given function when the client calls it.
   */
  tool(name: string, cb: ToolCallback): void;

  /**
   * Registers a zero-argument tool `name` (with a description) which will run the given function when the client calls it.
   */
  tool(name: string, description: string, cb: ToolCallback): void;

  /**
   * Registers a tool `name` accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  /**
   * Registers a tool `name` (with a description) accepting the given arguments, which must be an object containing named properties associated with Zod schemas. When the client calls it, the function will be run with the parsed and validated arguments.
   */
  tool<Args extends ZodRawShape>(
    name: string,
    description: string,
    paramsSchema: Args,
    cb: ToolCallback<Args>,
  ): void;

  tool(name: string, ...rest: unknown[]): void {
    if (this._registeredTools[name]) {
      throw new Error(`Tool ${name} is already registered`);
    }

    let description: string | undefined;
    if (typeof rest[0] === "string") {
      description = rest.shift() as string;
    }

    let paramsSchema: ZodRawShape | undefined;
    if (rest.length > 1) {
      paramsSchema = rest.shift() as ZodRawShape;
    }

    const cb = rest[0] as ToolCallback<ZodRawShape | undefined>;
    this._registeredTools[name] = {
      description,
      inputSchema:
        paramsSchema === undefined ? undefined : z.object(paramsSchema),
      callback: cb,
    };

    this.setToolRequestHandlers();
  }

  private setResourceRequestHandlers() {
    this.assertCanSetRequestHandler(
      ListResourcesRequestSchema.shape.method.value,
    );
    this.assertCanSetRequestHandler(
      ListResourceTemplatesRequestSchema.shape.method.value,
    );
    this.assertCanSetRequestHandler(
      ReadResourceRequestSchema.shape.method.value,
    );

    this.registerCapabilities({
      resources: {},
    });

    this.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = Object.entries(this._registeredResources).map(
        ([uri, resource]) => ({
          uri,
          name: resource.name,
          ...resource.metadata,
        }),
      );

      const templateResources: Resource[] = [];
      for (const template of Object.values(this._registeredResourceTemplates)) {
        if (!template.listCallback) {
          continue;
        }

        const result = await template.listCallback();
        for (const resource of result.resources) {
          templateResources.push({
            ...resource,
            ...template.metadata,
          });
        }
      }

      return { resources: [...resources, ...templateResources] };
    });

    this.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const resourceTemplates = Object.entries(
        this._registeredResourceTemplates,
      ).map(([name, template]) => ({
        name,
        uriTemplate: template.uriTemplate.toString(),
        ...template.metadata,
      }));

      return { resourceTemplates };
    });

    this.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = new URL(request.params.uri);

      // First check for exact resource match
      const resource = this._registeredResources[uri.toString()];
      if (resource) {
        return resource.readCallback(uri);
      }

      // Then check templates
      for (const template of Object.values(this._registeredResourceTemplates)) {
        const variables = template.uriTemplate.match(uri.toString());
        if (variables) {
          return template.readCallback(uri, variables);
        }
      }

      throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
    });
  }

  /**
   * Registers a resource `name` at a fixed URI, which will use the given callback to respond to read requests.
   */
  resource(name: string, uri: string, readCallback: ReadResourceCallback): void;

  /**
   * Registers a resource `name` at a fixed URI with metadata, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    uri: string,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a URI template pattern, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    uriTemplate: UriTemplate,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a URI template pattern and metadata, which will use the given callback to respond to read requests.
   */
  resource(
    name: string,
    uriTemplate: UriTemplate,
    metadata: ResourceMetadata,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a URI template pattern, which will use the list callback to enumerate matching resources and read callback to respond to read requests.
   */
  resource(
    name: string,
    uriTemplate: UriTemplate,
    listCallback: ListResourcesCallback,
    readCallback: ReadResourceCallback,
  ): void;

  /**
   * Registers a resource `name` with a URI template pattern and metadata, which will use the list callback to enumerate matching resources and read callback to respond to read requests.
   */
  resource(
    name: string,
    uriTemplate: UriTemplate,
    metadata: ResourceMetadata,
    listCallback: ListResourcesCallback,
    readCallback: ReadResourceCallback,
  ): void;

  resource(
    name: string,
    uriOrTemplate: string | UriTemplate,
    ...rest: unknown[]
  ): void {
    let metadata: ResourceMetadata | undefined;
    if (typeof rest[0] === "object") {
      metadata = rest.shift() as ResourceMetadata;
    }

    let listCallback: ListResourcesCallback | undefined;
    if (rest.length > 1) {
      listCallback = rest.shift() as ListResourcesCallback;
    }

    const readCallback = rest[0] as ReadResourceCallback;
    if (typeof uriOrTemplate === "string") {
      this.registerResource({
        name,
        uri: uriOrTemplate,
        metadata,
        readCallback,
      });
    } else {
      this.registerResourceTemplate({
        name,
        uriTemplate: uriOrTemplate,
        metadata,
        listCallback,
        readCallback,
      });
    }
  }

  private registerResource({
    name,
    uri,
    metadata,
    readCallback,
  }: {
    name: string;
    uri: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceCallback;
  }): void {
    if (this._registeredResources[uri]) {
      throw new Error(`Resource ${uri} is already registered`);
    }

    this._registeredResources[uri] = {
      name,
      metadata,
      readCallback,
    };

    this.setResourceRequestHandlers();
  }

  private registerResourceTemplate({
    name,
    uriTemplate,
    metadata,
    listCallback,
    readCallback,
  }: {
    name: string;
    uriTemplate: UriTemplate;
    metadata?: ResourceMetadata;
    listCallback?: ListResourcesCallback;
    readCallback: ReadResourceCallback;
  }): void {
    if (this._registeredResourceTemplates[name]) {
      throw new Error(`Resource template ${name} is already registered`);
    }

    this._registeredResourceTemplates[name] = {
      uriTemplate,
      metadata,
      listCallback,
      readCallback,
    };

    this.setResourceRequestHandlers();
  }
}
