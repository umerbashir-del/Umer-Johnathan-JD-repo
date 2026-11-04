import { describe, expect, it } from "vitest";
import type { SourceDocument } from "./documents";
import { verifyQuote } from "./verify-quotes";

const doc: SourceDocument = {
  id: "note-2026-11-03",
  type: "progress_note",
  title: "Day 3",
  version: 1,
  content: 'Subjective: Patient reports passive suicidal ideation\nwithout plan or intent. States "I\'m not going to do anything here."',
};

describe("verifyQuote", () => {
  it("verifies an exact quote and returns offsets into the original text", () => {
    const r = verifyQuote({ documentId: doc.id, text: "passive suicidal ideation" }, [doc]);
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(doc.content.slice(r.start, r.end)).toBe("passive suicidal ideation");
  });

  it("tolerates line breaks and extra spaces", () => {
    const r = verifyQuote({ documentId: doc.id, text: "suicidal ideation   without plan" }, [doc]);
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(r.excerpt).toBe("suicidal ideation\nwithout plan");
  });

  it("tolerates curly quotes and case", () => {
    const r = verifyQuote({ documentId: doc.id, text: "“I’M NOT GOING TO DO ANYTHING" }, [doc]);
    expect(r.status).toBe("verified");
  });

  it("rejects a paraphrase", () => {
    const r = verifyQuote({ documentId: doc.id, text: "patient denies suicidal ideation" }, [doc]);
    expect(r).toMatchObject({ status: "unsupported", reason: "text_not_found" });
  });

  it("rejects a quote citing the wrong document", () => {
    const r = verifyQuote({ documentId: "intake", text: "passive suicidal ideation" }, [doc]);
    expect(r).toMatchObject({ status: "unsupported", reason: "document_not_found" });
  });
});


it("maps Unicode lowercase expansions to original offsets", () => {
  const document = {id:"unicode",type:"progress_note" as const,title:"Synthetic",version:1,content:"İX"};
  expect(verifyQuote({documentId:"unicode",text:"x"},[document])).toMatchObject({status:"verified",start:1,end:2,excerpt:"X"});
  expect(verifyQuote({documentId:"unicode",text:"İ"},[document])).toMatchObject({status:"verified",start:0,end:1,excerpt:"İ"});
});
