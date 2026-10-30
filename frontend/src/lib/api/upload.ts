import type { ApiCredentials } from "@/lib/auth/tenant-context";
import { anvilApi, type ConfirmedDocument } from "./client";

const allowedTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const maxBytes = 52_428_800;

export type UploadStage = "presigning" | "encrypting" | "uploading" | "confirming";
export interface UploadCallbacks {
  onProgress?: (percent: number) => void;
  onStage?: (stage: UploadStage) => void;
}

function bytesFromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sha256Hex(value: ArrayBuffer) {
  return crypto.subtle.digest("SHA-256", value).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

function putPresignedObject(
  uploadUrl: string,
  requiredHeaders: Record<string, string>,
  ciphertext: ArrayBuffer,
  onProgress?: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.withCredentials = false;

    for (const [name, value] of Object.entries(requiredHeaders)) {
      // Browsers forbid setting Content-Length manually. The ArrayBuffer body makes the browser
      // send its exact byte length; validate it matches the signed header before sending.
      if (name.toLowerCase() === "content-length") {
        if (Number(value) !== ciphertext.byteLength) {
          reject(new Error("The signed upload length does not match the encrypted file."));
          return;
        }
        continue;
      }
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (event) => {
      if (!onProgress) return;
      const total = event.lengthComputable && event.total > 0 ? event.total : ciphertext.byteLength;
      onProgress(Math.min(100, Math.round((event.loaded / total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("The signed file upload failed. Request a new upload URL and retry."));
    };
    xhr.onerror = () => reject(new Error("The signed file upload could not reach storage. Check the connection and retry."));
    xhr.onabort = () => reject(new Error("The file upload was cancelled."));
    xhr.send(ciphertext);
  });
}

/** Executes only the presign → browser encryption → signed object PUT → confirm contract. */
export async function uploadCaseDocument(
  credentials: ApiCredentials,
  caseId: string,
  file: File,
  callbacks: UploadCallbacks = {},
): Promise<{ document: ConfirmedDocument; documentId: string; fileName: string }> {
  if (!allowedTypes.has(file.type)) throw new Error("Choose a PDF, JPEG, PNG, or DOCX file.");
  if (file.size < 1 || file.size > maxBytes) throw new Error("File size must be between 1 byte and 50 MiB.");

  callbacks.onStage?.("presigning");
  const plainBytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(plainBytes);
  const reservation = await anvilApi.CaseDocumentsController_presign(credentials, caseId, {
    contentType: file.type as
      | "application/pdf"
      | "image/jpeg"
      | "image/png"
      | "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: file.size,
    sha256,
  });

  const keyBytes = bytesFromBase64(reservation.encryption.keyBase64);
  const nonce = bytesFromBase64(reservation.encryption.nonceBase64);
  const additionalData = bytesFromBase64(reservation.encryption.additionalDataBase64);
  try {
    callbacks.onStage?.("encrypting");
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    // Web Crypto returns ciphertext followed by the 128-bit GCM authentication tag.
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData,
        tagLength: reservation.encryption.tagLengthBits,
      },
      key,
      plainBytes,
    );
    callbacks.onStage?.("uploading");
    callbacks.onProgress?.(0);
    await putPresignedObject(reservation.uploadUrl, reservation.requiredHeaders, encrypted, callbacks.onProgress);
    callbacks.onProgress?.(100);
  } finally {
    // Keep the one-time key bytes only as long as this upload operation needs them.
    keyBytes.fill(0);
    nonce.fill(0);
    additionalData.fill(0);
  }

  callbacks.onStage?.("confirming");
  const document = await anvilApi.DocumentsController_confirmUpload(credentials, reservation.documentId, sha256);
  return { document, documentId: reservation.documentId, fileName: file.name };
}
