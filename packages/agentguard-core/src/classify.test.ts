import { describe, expect, it } from "vitest";
import { classifyByName, classifyTool, effectiveClass } from "./classify.js";
import { matchesAny, matchesGlob } from "./glob.js";
import { defaultPolicy, parsePolicy } from "./policy.js";

describe("glob", () => {
  it("matches tool patterns", () => {
    expect(matchesGlob("crm_delete_contact", "crm_delete_*")).toBe(true);
    expect(matchesGlob("CRM_DELETE_CONTACT", "crm_delete_*")).toBe(true);
    expect(matchesGlob("crm_get_contact", "crm_delete_*")).toBe(false);
    expect(matchesGlob("fs.write_file", "fs.*")).toBe(true);
    expect(matchesAny("crm_delete_all", ["crm_*", "!crm_delete_all"])).toBe(false);
    expect(matchesAny("x", [])).toBe(false);
  });
});

describe("classifyByName", () => {
  it.each([
    ["crm_get_contact", "read", "read"],
    ["list_files", "read", "read"],
    ["searchContacts", "read", "read"],
    ["crm_delete_contact", "write", "delete"],
    ["crm_update_contact", "write", "update"],
    ["crm_create_contact", "write", "create"],
    ["email_send", "write", "send"],
    ["shell_execute", "write", "execute"],
    ["stripe_create_charge", "spend", "spend"],
    ["x402_pay", "spend", "spend"],
    ["get_or_create_user", "read", "read"],
    ["frobnicate", "unknown", "unknown"],
  ])("%s → %s/%s", (name, cls, verb) => {
    const r = classifyByName(name);
    expect(r.class).toBe(cls);
    expect(r.verb).toBe(verb);
  });
  it("flags destructive verbs", () => {
    expect(classifyByName("db_drop_table").destructive).toBe(true);
    expect(classifyByName("crm_update_contact").destructive).toBe(false);
  });
});

describe("classifyTool", () => {
  const policy = parsePolicy({
    classify: { write: ["notes_*"], read: ["danger_delete_readonly"], spend: ["pay_*"] },
  });
  it("policy beats annotations beats heuristics", () => {
    expect(
      classifyTool({ name: "notes_get", annotations: { readOnlyHint: true } }, policy).class,
    ).toBe("write");
    expect(
      classifyTool({ name: "notes_get", annotations: { readOnlyHint: true } }, policy).source,
    ).toBe("policy");
    expect(classifyTool({ name: "danger_delete_readonly" }, policy).class).toBe("read");
    expect(classifyTool({ name: "pay_anything" }, policy).class).toBe("spend");
    expect(
      classifyTool({ name: "frobnicate", annotations: { readOnlyHint: true } }, policy).class,
    ).toBe("read");
    const ann = classifyTool(
      { name: "frobnicate", annotations: { readOnlyHint: false, destructiveHint: true } },
      policy,
    );
    expect(ann.class).toBe("write");
    expect(ann.destructive).toBe(true);
    expect(classifyTool({ name: "crm_delete_contact" }, policy).source).toBe("heuristic");
    expect(classifyTool({ name: "frobnicate" }, policy).class).toBe("unknown");
  });
  it("unknown is a write in enforce unless the policy says otherwise", () => {
    const c = classifyTool({ name: "frobnicate" }, defaultPolicy());
    expect(effectiveClass(c, defaultPolicy())).toBe("write");
    expect(effectiveClass(c, parsePolicy({ classify: { unknown: "block" } }))).toBe("block");
    expect(effectiveClass(c, parsePolicy({ classify: { unknown: "read" } }))).toBe("read");
  });
});
