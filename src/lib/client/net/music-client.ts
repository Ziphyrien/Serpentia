import { Schema } from "effect";
import {
  MusicBackendErrorCode,
  MusicBackendErrorResponse,
  MusicBackendStatusResponse,
  MusicSearchResponse,
  type BackendDescriptor,
  type MusicBackendErrorCode as MusicBackendErrorCodeType,
  type MusicBackendStatusResponse as MusicBackendStatusResponseType,
  type MusicSearchRequest,
  type MusicSearchResponse as MusicSearchResponseType,
} from "$lib/protocol";

type MusicFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MusicClientError extends Schema.TaggedErrorClass<MusicClientError>()(
  "MusicClientError",
  {
    stage: Schema.Literals(["aborted", "transport", "protocol", "server"]),
    code: Schema.optionalKey(MusicBackendErrorCode),
    cause: Schema.Defect(),
  },
) {}

export class MusicClient {
  constructor(
    private readonly statusPath = "/api/music",
    private readonly searchPath = "/api/music/search",
    private readonly fetcher: MusicFetch = globalThis.fetch,
  ) {}

  static fromDescriptor(
    descriptor: BackendDescriptor,
    fetcher: MusicFetch = globalThis.fetch,
  ): MusicClient {
    return new MusicClient(descriptor.musicPath, descriptor.musicSearchPath, fetcher);
  }

  async readStatus(signal?: AbortSignal): Promise<MusicBackendStatusResponseType> {
    const response = await this.request(this.statusPath, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) throw await this.serverError(response);
    return this.decode(
      Schema.decodeUnknownPromise(MusicBackendStatusResponse),
      response,
      "status",
    );
  }

  async search(
    request: MusicSearchRequest,
    signal?: AbortSignal,
  ): Promise<MusicSearchResponseType> {
    const response = await this.request(this.searchPath, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await this.serverError(response);
    return this.decode(Schema.decodeUnknownPromise(MusicSearchResponse), response, "search");
  }

  private async request(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (cause) {
      throw MusicClientError.make({
        stage: init.signal?.aborted ? "aborted" : "transport",
        cause,
      });
    }
  }

  private async serverError(response: Response): Promise<MusicClientError> {
    try {
      const body = await Schema.decodeUnknownPromise(MusicBackendErrorResponse)(
        await response.json(),
      );
      return MusicClientError.make({ stage: "server", code: body.error, cause: body.error });
    } catch (cause) {
      if (cause instanceof MusicClientError) return cause;
      return MusicClientError.make({ stage: "protocol", cause });
    }
  }

  private async decode<A>(
    decode: (input: unknown) => Promise<A>,
    response: Response,
    operation: string,
  ): Promise<A> {
    try {
      return await decode(await response.json());
    } catch (cause) {
      throw MusicClientError.make({
        stage: "protocol",
        cause: new Error(`Invalid music ${operation} response`, { cause }),
      });
    }
  }
}

export function isMusicServerError(
  error: MusicClientError,
  code: MusicBackendErrorCodeType,
): boolean {
  return error.stage === "server" && error.code === code;
}
