import "server-only";

export const UNTRUSTED_TAGS = ["document", "prior_output", "db_text"] as const;
export type UntrustedTag = (typeof UNTRUSTED_TAGS)[number];
export const TAG_REMOVED = "[tag removed]";
const names = UNTRUSTED_TAGS.join("|");
const prefix = `(?:<|＜|﹤|&lt;|&#60;|&#x3c;)\\s*/?\\s*(?:${names})(?![A-Za-z0-9_-])`;
const tagPattern = new RegExp(`${prefix}(?:[\\s A-Za-z0-9_"'=:./-]{0,256}(?:>|＞|﹥|&gt;|&#62;|&#x3e;))?`, "gi");

export function neutralizeTags(text: string): string {
  return text.replace(tagPattern, TAG_REMOVED);
}
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function wrapUntrusted(tag: UntrustedTag, attributes: ReadonlyArray<readonly [string, string | number | null | undefined]>, content: string): string {
  const rendered = attributes.map(([name, value]) => {
    if (!/^[a-z][a-z_]*$/.test(name)) throw new Error("invalid attribute name");
    if (value === null || value === undefined || value === "") return "";
    return ` ${name}="${escapeAttribute(String(value))}"`;
  }).join("");
  return `<${tag}${rendered}>\n${neutralizeTags(content)}\n</${tag}>`;
}
