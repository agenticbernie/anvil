"use client";

import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useCaseDocuments } from "@/hooks/useCases";
import { UploadDocumentModal, type UploadedDocumentResult } from "@/components/cases/UploadDocumentModal";
import type { CaseDocument, CreditCase } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";

function documentType(contentType: CaseDocument["contentType"]) {
  switch (contentType) {
    case "application/pdf": return "PDF";
    case "image/jpeg": return "JPEG";
    case "image/png": return "PNG";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "DOCX";
  }
}

function statusVariant(status: CaseDocument["status"]) {
  if (status === "processed") return "success" as const;
  if (status === "failed" || status === "rejected") return "error" as const;
  if (status === "uploaded" || status === "processing") return "info" as const;
  return "warning" as const;
}

function statusLabel(status: CaseDocument["status"]) {
  return status.replaceAll("_", " ");
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatSize(sizeBytes: number) {
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentList({ caseId, onUploadAccepted }: { caseId: CreditCase["id"]; onUploadAccepted: (result: UploadedDocumentResult) => void }) {
  const { credentials } = useAuthTenant();
  const toast = useToast();
  const [sessionFileNames, setSessionFileNames] = useState<Record<string, string>>({});
  const query = useCaseDocuments(caseId);

  useEffect(() => {
    if (query.error) toast({ body: query.error.message, type: "error", uniqueID: "documents-read-error" });
  }, [query.error, toast]);

  function onUploaded(result: UploadedDocumentResult) {
    setSessionFileNames((current) => ({ ...current, [result.documentId]: result.fileName }));
    onUploadAccepted(result);
  }

  const documents = query.data?.items ?? [];

  return (
    <section aria-labelledby="documents-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="documents-heading" className="font-semibold text-slate-900">Documents</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
            Safe metadata returned for this case. The API provides MIME type, not business categories such as Lease or Invoice.
          </p>
        </div>
        <UploadDocumentModal caseId={caseId} onUploaded={onUploaded} />
      </div>

      {!credentials ? (
        <Message title="Connect an API session" body="Add a bearer token and tenant UUID in the header to load documents." />
      ) : query.isPending ? (
        <div className="grid min-h-48 place-items-center text-sm text-slate-500" role="status">Loading documents…</div>
      ) : query.isError ? (
        <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4" role="alert">
          <p className="text-sm font-medium text-rose-900">Could not load documents</p>
          <p className="mt-1 text-sm text-rose-800">{query.error.message}</p>
          <Button label="Try again" variant="secondary" size="sm" onClick={() => void query.refetch()} className="mt-3" />
        </div>
      ) : documents.length === 0 ? (
        <Message title="No documents" body="The API returned no document records for this case." />
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[700px] border-collapse text-left">
            <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">File name</th>
                <th className="px-4 py-3">File type</th>
                <th className="px-4 py-3">Processing status</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-5 py-3 text-right">Size</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {documents.map((document) => (
                <tr key={document.id}>
                  <td className="px-5 py-4">
                    <p className="text-sm font-medium text-slate-800">{sessionFileNames[document.id] ?? "Filename not provided by API"}</p>
                    <p className="mt-1 font-mono text-[10px] text-slate-400">Document ID {document.id}</p>
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600">{documentType(document.contentType)}</td>
                  <td className="px-4 py-4"><Badge label={statusLabel(document.status)} variant={statusVariant(document.status)} /></td>
                  <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">{formatDate(document.createdAt)}</td>
                  <td className="whitespace-nowrap px-5 py-4 text-right text-sm text-slate-500">{formatSize(document.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-400">Storage object keys, file hashes, and encryption values are never rendered.</p>
    </section>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-6 grid min-h-44 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 text-center">
      <div><p className="text-sm font-medium text-slate-800">{title}</p><p className="mt-1 text-sm text-slate-500">{body}</p></div>
    </div>
  );
}
