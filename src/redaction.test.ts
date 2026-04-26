import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSensitiveKey, redactSecrets, redactText, StreamingRedactor } from "./redaction.js";

const OPENAI_KEY = "sk-123456789012345678901234";
const GITHUB_TOKEN = "ghp_123456789012345678901234567890123456";

describe("redaction", () => {
  it("redacts common secret patterns inside free text", () => {
    const text = [
      `OPENAI_API_KEY=${OPENAI_KEY}`,
      `Authorization: Bearer ${GITHUB_TOKEN}`,
      "https://user:password@example.com/private.git",
    ].join("\n");

    const redacted = redactText(text);

    assert.doesNotMatch(redacted, new RegExp(OPENAI_KEY));
    assert.doesNotMatch(redacted, new RegExp(GITHUB_TOKEN));
    assert.doesNotMatch(redacted, /user:password/);
    assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/);
    assert.match(redacted, /Authorization: Bearer \[REDACTED\]/);
    assert.match(redacted, /https:\/\/\[REDACTED\]@example\.com/);
  });

  it("redacts sensitive object keys recursively without mutating input", () => {
    const value = {
      name: "agent",
      config: {
        secretKey: "ak_secret_should_not_persist",
        access_token: "access-token-value",
      },
      output: `finished with ${OPENAI_KEY}`,
      nested: [{ rawApiKey: "raw-key-value" }],
    };

    const redacted = redactSecrets(value);

    assert.equal(redacted.name, "agent");
    assert.equal(redacted.config.secretKey, "[REDACTED]");
    assert.equal(redacted.config.access_token, "[REDACTED]");
    assert.equal(redacted.nested[0].rawApiKey, "[REDACTED]");
    assert.doesNotMatch(redacted.output, new RegExp(OPENAI_KEY));
    assert.equal(value.config.secretKey, "ak_secret_should_not_persist");
  });

  it("classifies narrow auth keys without treating token counters as secrets", () => {
    assert.equal(isSensitiveKey("secretKey"), true);
    assert.equal(isSensitiveKey("access_token"), true);
    assert.equal(isSensitiveKey("rawApiKey"), true);
    assert.equal(isSensitiveKey("tokenLimit"), false);
    assert.equal(isSensitiveKey("tokensToday"), false);
  });

  it("streams ordinary chunks without buffering", () => {
    const redactor = new StreamingRedactor();

    assert.equal(redactor.push("hello "), "hello ");
    assert.equal(redactor.push("world\n"), "world\n");
    assert.equal(redactor.flush(), "");
  });

  it("redacts secret assignments split across stream chunks", () => {
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push("before OPENAI_API_KEY=sk-123456789012"),
      redactor.push("345678901234 after\n"),
      redactor.flush(),
    ].join("");

    assert.doesNotMatch(output, /sk-123456789012345678901234/);
    assert.match(output, /before OPENAI_API_KEY=\[REDACTED\] after/);
  });

  it("holds and redacts bare known tokens split across stream chunks", () => {
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push("token sk-123456789012"),
      redactor.push("345678901234\n"),
      redactor.flush(),
    ].join("");

    assert.doesNotMatch(output, /sk-123456789012345678901234/);
    assert.match(output, /token \[REDACTED\]/);
  });

  it("holds and redacts private key blocks split across stream chunks", () => {
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push("key -----BEGIN PRIVATE KEY-----\nabc123"),
      redactor.push("\n-----END PRIVATE KEY-----\n"),
      redactor.flush(),
    ].join("");

    assert.doesNotMatch(output, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(output, /abc123/);
    assert.match(output, /key \[REDACTED\]/);
  });
});
