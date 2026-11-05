import { describe, expect, it } from "vitest";
import { call, HttpClient, mcpClient, ownerWithBase } from "./helpers";

describe("path lookup over MCP and the REST API", () => {
  it("is created, described, read, filtered and explained, and refuses writes and other filters", async () => {
    const { c, token, baseId } = await ownerWithBase("path-api", "blank");
    const mcp = await mcpClient(token);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(mcp, name, { baseId, ...args });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      return r.structuredContent;
    };
    await ok("create_table", { name: "Emails", fields: [{ name: "Address", type: "text" }] });
    await ok("create_table", { name: "GitHub", fields: [{ name: "Login", type: "text" }, { name: "Email", type: "link", options: { linkedTable: "Emails" } }] });
    await ok("create_table", {
      name: "Accounts",
      fields: [{ name: "Handle", type: "text" }, { name: "Platform", type: "singleSelect", options: { choices: ["xxx", "yyy"] } }, { name: "Login", type: "link", options: { linkedTable: "GitHub" } }, { name: "Referrer", type: "link", options: { linkedTable: "Emails", pathRole: "none" } }],
    });
    const created = await ok("create_field", {
      table: "Emails",
      field: { name: "Used on xxx", type: "pathLookup", options: { targetTable: "Accounts", direction: "dependents", targetFilter: { conditions: [{ field: "Platform", op: "eq", value: "xxx" }] } } },
    });
    expect(created.field.options).toMatchObject({ targetTable: "Accounts", direction: "dependents", links: ["Emails.GitHub", "GitHub.Accounts"] });
    expect(created.field.options.targetFilter.conditions[0]).toMatchObject({ field: "Platform", op: "eq" });

    const emails = await ok("create_records", { table: "Emails", records: [{ fields: { Address: "a@x.com" } }, { fields: { Address: "b@x.com" } }] });
    const [e1, e2] = emails.records.map((r: any) => r.id);
    const gh = await ok("create_records", { table: "GitHub", records: [{ fields: { Login: "alice-dev", Email: [e1] } }] });
    const acc = await ok("create_records", { table: "Accounts", records: [{ fields: { Handle: "alice123", Platform: "xxx", Login: [gh.records[0].id], Referrer: [e2] } }] });
    const a1 = acc.records[0].id;

    const got = await ok("get_records", { table: "Emails", ids: [e1, e2] });
    expect(got.records.map((r: any) => r.fields["Used on xxx"] ?? [])).toEqual([[a1], []]);
    const unused = await ok("query_records", { table: "Emails", filter: { conditions: [{ field: "Used on xxx", op: "empty" }] } });
    expect(unused.records.map((r: any) => r.id)).toEqual([e2]);

    const bad = await call(mcp, "query_records", { baseId, table: "Emails", filter: { conditions: [{ field: "Used on xxx", op: "eq", value: a1 }] } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/empty, notempty/);
    const write = await call(mcp, "update_records", { baseId, table: "Emails", records: [{ id: e2, fields: { "Used on xxx": [a1] } }] });
    expect(write.isError).toBe(true);
    const sort = await call(mcp, "query_records", { baseId, table: "Emails", sort: [{ field: "Used on xxx" }] });
    expect(sort.isError).toBe(true);
    expect(JSON.stringify(sort.content)).toMatch(/cannot be sorted/);

    const api = new HttpClient(token);
    const rest = await api.req("GET", `/api/v1/${baseId}/Emails/${e1}`);
    expect(rest.json.fields["Used on xxx"]).toEqual([a1]);
    const put = await api.req("PATCH", `/api/v1/${baseId}/Emails/${e1}`, { fields: { "Used on xxx": [] } });
    expect(put.status).toBe(422);
    const why = await api.req("GET", `/api/v1/${baseId}/Emails/${e1}/paths?fieldId=${encodeURIComponent("Used on xxx")}&target=${a1}`);
    expect(why.status).toBe(200);
    expect(why.json.path.map((h: any) => [h.title, h.via])).toEqual([["a@x.com", undefined], ["alice-dev", "GitHub"], ["alice123", "Accounts"]]);
    expect((await api.req("GET", `/api/v1/${baseId}/Emails/${e2}/paths?fieldId=${encodeURIComponent("Used on xxx")}&target=${a1}`)).status).toBe(404);

    // Formulas would read cells cut at 100 records, so they cannot name a path lookup.
    const formula = await api.req("GET", `/api/v1/${baseId}/Emails?filterByFormula=${encodeURIComponent("{Used on xxx} = BLANK()")}`);
    expect(formula.status).toBe(422);
    // A cell cut at 100 records says so.
    const many = await api.req("POST", `/api/v1/${baseId}/Accounts`, { records: Array.from({ length: 101 }, (_, i) => ({ fields: { Handle: "h" + i, Platform: "xxx", Login: [gh.records[0].id] } })), typecast: true });
    expect(many.status).toBe(200);
    const capped = await api.req("GET", `/api/v1/${baseId}/Emails/${e1}`);
    expect(capped.json.fields["Used on xxx"]).toHaveLength(100);
    expect(capped.json.paths).toEqual({ "Used on xxx": { total: 102 } });
    const viaMcp = await ok("get_records", { table: "Emails", ids: [e1] });
    expect(viaMcp.records[0].paths).toEqual({ "Used on xxx": { total: 102 } });

    // The app's own route answers the same question.
    const schema = (await c.req("GET", `/api/bases/${baseId}`)).json.schema;
    const fieldId = schema.fields.find((f: any) => f.name === "Used on xxx").id;
    const app = await c.req("POST", `/api/bases/${baseId}/paths/explain`, { fieldId, rowId: e1, targetId: a1 });
    expect(app.json.path).toHaveLength(3);
  });
});
