"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "@astryxdesign/core/Toast";
import { useUploadCaseDocument } from "@/hooks/useCases";
import { ApiError, type CreditCase } from "@/lib/api/client";
import { useAuthTenant } from "@/lib/auth/tenant-context";
import type { UploadStage } from "@/lib/api/upload";

export interface UploadedDocumentResult {
  documentId: string;
  fileName: string;
  jobId: string;
}

const stageLabels: Record<UploadStage | "complete", string> = {
  presigning: "Securing upload",
  encrypting: "Encrypting in your browser",
  uploading: "Uploading encrypted file",
  confirming: "Queueing document processing",
  complete: "Upload accepted",
};

export function UploadDocumentModal({
  caseId,
  onUploaded,
}: {
  caseId: CreditCase["id"];
  onUploaded: (result: UploadedDocumentResult) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { credentials } = useAuthTenant();
  const queryClient = useQueryClient();
  const toast = useToast();
  const upload = useUploadCaseDocument(caseId);
  const [isOpen, setIsOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<UploadStage | "complete" | null>(null);
  const [safeError, setSafeError] = useState("");

  useEffect(() => {
    if (!upload.error) return;
    const message = upload.error instanceof ApiError
      ? upload.error.message
      : upload.error instanceof Error && [
          "Choose a PDF, JPEG, PNG, or DOCX file.",
          "File size must be between 1 byte and 50 MiB.",
          "The signed upload length does not match the encrypted file.",
          "The signed upload content type does not match the selected file.",
          "The signed file upload failed. Request a new upload URL and retry.",
          "The signed file upload could not reach storage. Check the connection and retry.",
          "The file upload was cancelled.",
        ].includes(upload.error.message)
        ? upload.error.message
        : "The upload could not be completed. Check the file and connection, then retry.";
    setSafeError(message);
    toast({ body: message, type: "error", uniqueID: "document-upload-error" });
  }, [toast, upload.error]);

  function open() {
    setFile(null);
    setStage(null);
    setSafeError("");
    setIsOpen(true);
  }

  function close() {
    if (upload.isPending) return;
    setIsOpen(false);
    setFile(null);
    setSafeError("");
  }

  function acceptDroppedFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    setFile(event.dataTransfer.files.item(0));
    setSafeError("");
  }

  async function submit() {
    if (!file || !credentials) return;
    setSafeError("");
    try {
      const result = await upload.uploadFile(file, {
        onStage: setStage,
      });
      setStage("complete");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["case-documents", credentials.tenantId, credentials.sessionRevision, caseId],
          refetchType: "all",
        }),
        queryClient.invalidateQueries({
          queryKey: ["case", credentials.tenantId, credentials.sessionRevision, caseId],
          refetchType: "all",
        }),
      ]);
      onUploaded({ documentId: result.documentId, fileName: result.fileName, jobId: result.document.job_id });
      toast({ body: "Document uploaded and processing queued", uniqueID: "document-upload-success" });
    } catch {
      // Error message is normalized by the mutation error effect above.
    }
  }

  return (
    <>
      <Button label="Upload Document" variant="primary" size="sm" onClick={open} isDisabled={!credentials} />
      {isOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="upload-dialog-title" className="w-full max-w-xl rounded-2xl bg-white p-5 shadow-2xl md:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow text-[10px] font-semibold text-emerald-800">Secure document intake</p>
                <h2 id="upload-dialog-title" className="mt-2 text-xl font-semibold text-slate-950">Upload a document</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">Files are encrypted in your browser before they are sent to storage.</p>
              </div>
              <button type="button" aria-label="Close upload dialog" onClick={close} disabled={upload.isPending} className="rounded-md px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 disabled:opacity-40">×</button>
            </div>

            <input
              ref={input}
              type="file"
              className="sr-only"
              accept="application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => { setFile(event.target.files?.item(0) ?? null); setSafeError(""); }}
              aria-label="Choose a PDF, JPEG, PNG, or DOCX file"
            />
            <div
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={acceptDroppedFile}
              className={`mt-6 rounded-xl border border-dashed p-7 text-center transition-colors ${isDragging ? "border-emerald-700 bg-emerald-50" : "border-slate-300 bg-slate-50"}`}
            >
              <p className="text-sm font-medium text-slate-800">{file?.name ?? "Drop a file here"}</p>
              <p className="mt-1 text-xs text-slate-500">PDF, JPEG, PNG, or DOCX · maximum 50 MiB</p>
              {file && <p className="mt-2 text-xs text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MiB</p>}
              <Button label={file ? "Choose a different file" : "Choose file"} variant="secondary" size="sm" onClick={() => input.current?.click()} isDisabled={upload.isPending} className="mt-4" />
            </div>

            {upload.isPending && stage && (
              <div className="mt-5" role="status" aria-live="polite">
                <div className="mb-2 flex justify-between gap-3 text-xs text-slate-600">
                  <span>{stageLabels[stage]}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Encrypted upload progress">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-700" />
                </div>
              </div>
            )}
            {stage === "complete" && <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">Upload accepted. Background processing has been queued.</p>}
            {safeError && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{safeError}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <Button label={stage === "complete" ? "Done" : "Cancel"} variant="ghost" size="sm" onClick={close} isDisabled={upload.isPending} />
              {stage !== "complete" && <Button label="Upload and process" variant="primary" size="sm" onClick={submit} isDisabled={!file || upload.isPending || !credentials} isLoading={upload.isPending} />}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
