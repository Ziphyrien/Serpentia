import { createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { BilibiliAudioQuality } from "../../../protocol";
import { BilibiliTrack } from "./contracts";
import { bilibiliError } from "./errors";

const TRACK_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const STREAM_TTL_MILLISECONDS = 12 * 60 * 60 * 1_000;
const TOKEN_PATTERN = /^[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+$/u;

class TrackTicketPayload extends Schema.Class<TrackTicketPayload>("TrackTicketPayload")({
  version: Schema.Literal(1),
  kind: Schema.Literal("track"),
  track: BilibiliTrack,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

class StreamTicketPayload extends Schema.Class<StreamTicketPayload>("StreamTicketPayload")({
  version: Schema.Literal(1),
  kind: Schema.Literal("stream"),
  bvid: BilibiliTrack.fields.bvid,
  cid: Schema.Int.check(Schema.isGreaterThan(0)),
  quality: BilibiliAudioQuality,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export type StreamTicket = typeof StreamTicketPayload.Type;

export class BilibiliTicketService {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createHmac("sha256", secret).update("serpentia:bilibili:ticket:v1").digest();
  }

  issueTrack(track: BilibiliTrack): string {
    const token = this.sign(
      TrackTicketPayload.make({
        version: 1,
        kind: "track",
        track,
        expiresAt: this.now() + TRACK_TTL_MILLISECONDS,
      }),
    );
    if (token.length > 2_048) {
      throw bilibiliError("PROTOCOL_ERROR", "ticket.track", "Bilibili track reference is too large");
    }
    return token;
  }

  async verifyTrack(token: string): Promise<BilibiliTrack> {
    let payload: TrackTicketPayload;
    try {
      payload = await Schema.decodeUnknownPromise(TrackTicketPayload)(this.verifyPayload(token));
    } catch {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket payload");
    }
    if (payload.expiresAt <= this.now()) {
      throw bilibiliError("INVALID_REQUEST", "ticket.track", "Music search result has expired");
    }
    return payload.track;
  }

  issueStream(bvid: string, cid: number, quality: BilibiliAudioQuality): string {
    return this.sign(
      StreamTicketPayload.make({
        version: 1,
        kind: "stream",
        bvid,
        cid,
        quality,
        expiresAt: this.now() + STREAM_TTL_MILLISECONDS,
      }),
    );
  }

  async verifyStream(token: string): Promise<StreamTicket> {
    let payload: StreamTicketPayload;
    try {
      payload = await Schema.decodeUnknownPromise(StreamTicketPayload)(this.verifyPayload(token));
    } catch {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket payload");
    }
    if (payload.expiresAt <= this.now()) {
      throw bilibiliError("INVALID_REQUEST", "ticket.stream", "Music stream ticket has expired");
    }
    return payload;
  }

  private sign(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifyPayload(token: string): unknown {
    if (token.length > 2_048 || !TOKEN_PATTERN.test(token)) {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket");
    }
    const [body, encodedSignature, extra] = token.split(".");
    if (body === undefined || encodedSignature === undefined || extra !== undefined) {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket");
    }
    const expected = createHmac("sha256", this.key).update(body).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(encodedSignature, "base64url");
    } catch {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket");
    }
    if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket signature");
    }
    try {
      const raw: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return raw;
    } catch {
      throw bilibiliError("INVALID_REQUEST", "ticket.verify", "Invalid music ticket payload");
    }
  }
}
