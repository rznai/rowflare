import { describe, expect, it } from "vitest";
import { call, HttpClient, mcpClient, ownerWithBase } from "./helpers";

describe("value match over MCP and the REST API", () => {
  it("is set, described, read and explained, and can be removed", async () => {
    const { token, baseId } = await ownerWithBase("match-api", "blank");
    const mcp = await mcpClient(token);
    const ok = async (name: string, args: Record<string, unknown>) => {
      const r = await call(mcp, name, { baseId, ...args });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      return r.structuredContent;
    };
    await ok("create_table", { name: "Emails", fields: [{ name: "Address", type: "text" }, { name: "Count", type: "number" }] });
    await ok("create_table", { name: "Twitter", fields: [{ name: "Handle", type: "text" }, { name: "Email", type: "email", options: { match: { table: "Emails", field: "Address" } } }] });
    await ok("create_table", { name: "Accounts", fields: [{ name: "Handle", type: "text" }, { name: "Twitter", type: "link", options: { linkedTable: "Twitter" } }] });
    const pl = await ok("create_field", { table: "Emails", field: { name: "Accounts", type: "pathLookup", options: { targetTable: "Accounts" } } });
    expect(pl.field.options.links).toEqual(["Twitter.Accounts", "Twitter.Email = Emails.Address"]);

    const emails = await ok("create_records", { table: "Emails", records: [{ fields: { Address: "a@x.com" } }] });
    const e1 = emails.records[0].id;
    const tw = await ok("create_records", { table: "Twitter", records: [{ fields: { Handle: "@alice", Email: "A@x.com" } }] });
    const t1 = tw.records[0].id;
    const acc = await ok("create_records", { table: "Accounts", records: [{ fields: { Handle: "alice1", Twitter: [t1] } }] });
    const a1 = acc.records[0].id;

    const got = await ok("get_records", { table: "Twitter", ids: [t1] });
    expect(got.records[0].matches).toEqual({ Email: [e1] });
    const api = new HttpClient(token);
    const rest = await api.req("GET", `/api/v1/${baseId}/Twitter/${t1}`);
    expect(rest.json.fields.Email).toBe("A@x.com");
    expect(rest.json.matches).toEqual({ Email: [e1] });
    expect((await api.req("GET", `/api/v1/${baseId}/Emails/${e1}`)).json.fields.Accounts).toEqual([a1]);
    const why = await api.req("GET", `/api/v1/${baseId}/Emails/${e1}/paths?fieldId=Accounts&target=${a1}`);
    expect(why.json.path.map((h: any) => [h.title, h.via, h.match])).toEqual([["a@x.com", undefined, undefined], ["@alice", "Email", true], ["alice1", "Accounts", undefined]]);

    const emailField = async () => (await ok("describe_base", {})).tables.find((t: any) => t.name === "Twitter").fields.find((f: any) => f.name === "Email");
    expect((await emailField()).options).toMatchObject({ match: "Emails.Address" });
    const bad = await call(mcp, "update_field", { baseId, table: "Twitter", field: "Email", options: { match: { table: "Emails", field: "Count" } } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Choose a text, email, URL or phone field/);
    const wrongType = await call(mcp, "create_field", { baseId, table: "Twitter", field: { name: "N", type: "number", options: { match: { table: "Emails", field: "Address" } } } });
    expect(wrongType.isError).toBe(true);

    await ok("update_field", { table: "Twitter", field: "Email", options: { match: null } });
    expect((await emailField()).options?.match).toBeUndefined();
    expect((await api.req("GET", `/api/v1/${baseId}/Twitter/${t1}`)).json.matches).toBeUndefined();
  });
});
