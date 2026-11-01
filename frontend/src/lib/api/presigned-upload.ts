export async function putPresignedObject(
  uploadUrl: string,
  requiredHeaders: Record<string, string>,
  ciphertext: ArrayBuffer,
  contentType: string,
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requiredHeaders)) {
    // Content-Length is browser-controlled; validate the ciphertext length before sending.
    if (name.toLowerCase() === "content-length") {
      if (Number(value) !== ciphertext.byteLength) {
        throw new Error("The signed upload length does not match the encrypted file.");
      }
      continue;
    }
    headers.set(name, value);
  }
  if (headers.get("content-type") !== contentType) {
    throw new Error("The signed upload content type does not match the selected file.");
  }

  let response: Response;
  try {
    response = await fetch(uploadUrl, { method: "PUT", headers, body: ciphertext, credentials: "omit", redirect: "error" });
  } catch {
    throw new Error("The signed file upload could not reach storage. Check the connection and retry.");
  }
  if (!response.ok) throw new Error("The signed file upload failed. Request a new upload URL and retry.");
}
