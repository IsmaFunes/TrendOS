import { SignUp } from "@clerk/nextjs";
import { BrandLogo } from "@/components/BrandLogo";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <BrandLogo href="/" />
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/onboarding"
      />
    </main>
  );
}
