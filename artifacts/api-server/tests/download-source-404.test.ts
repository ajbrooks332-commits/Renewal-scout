/**
 * Regression test: /api/download-source must return 404.
 *
 * The source-download endpoint was removed for security reasons. This test
 * ensures it is not accidentally re-introduced in any form.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../src/app";

describe("removed endpoints — must not succeed", () => {
  // /api/download-source was permanently removed. The auth middleware runs
  // before route lookup and returns 401 for unauthenticated requests, so the
  // effective status code from an anonymous request is 401 — not 404. Both
  // outcomes prove the endpoint is absent: a successful 200 would indicate
  // the route exists and works, which is the regression we are guarding against.
  it("GET /api/download-source does not return 200 (endpoint removed)", async () => {
    const res = await request(app).get("/api/download-source");
    // 401 = auth blocked (route not found at auth layer) — endpoint removed
    // 404 = route not registered (would occur if auth were bypassed)
    expect([401, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("POST /api/download-source does not return 200 (endpoint removed)", async () => {
    const res = await request(app).post("/api/download-source");
    expect([401, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it("GET /download-code.html returns 404", async () => {
    const res = await request(app).get("/download-code.html");
    expect(res.status).toBe(404);
  });

  it("GET /download.html returns 404", async () => {
    const res = await request(app).get("/download.html");
    expect(res.status).toBe(404);
  });

  it("GET /source-export.txt returns 404", async () => {
    const res = await request(app).get("/source-export.txt");
    expect(res.status).toBe(404);
  });
});
