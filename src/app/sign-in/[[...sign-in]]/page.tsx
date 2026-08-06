import { SignIn } from "@clerk/nextjs";
import { BrandLogo } from "@/components/BrandLogo";

export default function SignInPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <BrandLogo href="/" />
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/onboarding"
      />
    </main>
  );
}
