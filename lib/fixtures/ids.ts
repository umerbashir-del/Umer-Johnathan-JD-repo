import { createHash } from "node:crypto";
export function fixtureId(caseId:string,path:string):string {
 const hex=createHash("sha256").update(`ur-fixture:${caseId}:${path}`).digest("hex").slice(0,32);
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
}
export function contentHash(text:string) { return createHash("sha256").update(text).digest("hex"); }
