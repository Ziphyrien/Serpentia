import { describe, expect, it } from "vite-plus/test";
import { MusicSourceError } from "./errors";
import { MusicOutboundHttp } from "./outbound-http";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];

describe("music source outbound HTTP", () => {
  it("forwards a bounded public request and parses JSON like LX", async () => {
    let observed: Request | undefined;
    const client = new MusicOutboundHttp(async (input, init) => {
      observed = new Request(input, init);
      return Response.json({ code: 0, data: "ok" }, { status: 200 });
    }, publicLookup);

    const result = await client.request("https://api.example.test/music", {
      method: "POST",
      headers: { "x-request-key": "key", cookie: "secret" },
      body: { id: "song" },
    });

    expect(observed?.method).toBe("POST");
    expect(observed?.headers.get("x-request-key")).toBe("key");
    expect(observed?.headers.has("cookie")).toBe(false);
    expect(result.body).toEqual({ code: 0, data: "ok" });
    expect(result.response.bytes).toBeGreaterThan(0);
  });

  it("rejects loopback, private DNS answers, credentials, and custom ports", async () => {
    const privateLookup = async () => [{ address: "10.0.0.1", family: 4 }];
    const client = new MusicOutboundHttp(globalThis.fetch, privateLookup);

    await expect(client.assertPublicUrl("http://127.0.0.1/file")).rejects.toBeInstanceOf(
      MusicSourceError,
    );
    await expect(
      client.assertPublicUrl("https://internal.example.test/file"),
    ).rejects.toBeInstanceOf(MusicSourceError);
    await expect(
      client.assertPublicUrl("https://user:pass@example.test/file"),
    ).rejects.toBeInstanceOf(MusicSourceError);
    await expect(client.assertPublicUrl("https://example.test:8443/file")).rejects.toBeInstanceOf(
      MusicSourceError,
    );
  });

  it("revalidates redirect targets before following them", async () => {
    let calls = 0;
    const client = new MusicOutboundHttp(async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    }, publicLookup);

    await expect(client.request("https://api.example.test/start", {})).rejects.toBeInstanceOf(
      MusicSourceError,
    );
    expect(calls).toBe(1);
  });

  it("rejects responses over the decompressed byte limit", async () => {
    const client = new MusicOutboundHttp(
      async () => new Response(new Uint8Array(2_097_153)),
      publicLookup,
    );

    await expect(client.request("https://api.example.test/large", {})).rejects.toBeInstanceOf(
      MusicSourceError,
    );
  });
});
