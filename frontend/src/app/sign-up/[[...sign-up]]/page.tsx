import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignUpPage() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Suspense fallback={<p className="text-sm text-slate-500">Loading sign-up…</p>}>
        <SignUp />
      </Suspense>
    </div>
  );
}
