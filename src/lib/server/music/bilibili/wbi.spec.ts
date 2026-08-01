import { describe, expect, it } from "vite-plus/test";
import { BilibiliApiClient } from "./client";
import { BilibiliCredentials } from "./credentials";
import { signWbi, WbiSigner } from "./wbi";

describe("WBI signing", () => {
  it("sorts, filters, timestamps, and signs without mutating the input", () => {
    const input = { foo: "114", bar: "5!14", baz: 1_919_810 };
    const signed = signWbi(
      input,
      "7cd084941338484aae1ad9425b84077c",
      "4932caff0ff746eab6f01bf08b70ac45",
      1_702_204_169,
    );
    expect(signed).toBe(
      "bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee",
    );
    expect(input).toEqual({ foo: "114", bar: "5!14", baz: 1_919_810 });
  });

  it("does not let one caller cancel the shared cold-key load", async () => {
    const requestStarted = Promise.withResolvers<void>();
    const requestCompletion = Promise.withResolvers<void>();
    let requests = 0;
    const fetcher = async (): Promise<Response> => {
      requests += 1;
      requestStarted.resolve();
      await requestCompletion.promise;
      return Response.json({
        code: 0,
        data: {
          isLogin: true,
          wbi_img: {
            img_url: "https://i0.hdslb.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            sub_url: "https://i0.hdslb.com/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png",
          },
        },
      });
    };
    const client = new BilibiliApiClient(
      BilibiliCredentials.fromEnvironment("SESSDATA=fake"),
      fetcher,
    );
    const signer = new WbiSigner(client, () => 1_700_000_000_000);
    const firstController = new AbortController();
    const first = signer.sign({ keyword: "first" }, firstController.signal);
    const second = signer.sign({ keyword: "second" });
    await requestStarted.promise;
    firstController.abort();
    requestCompletion.resolve();

    await expect(first).rejects.toMatchObject({ reason: "TIMEOUT" });
    await expect(second).resolves.toContain("keyword=second");
    expect(requests).toBe(1);
  });
});
