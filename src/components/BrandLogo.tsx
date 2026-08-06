import Link from "next/link";
import { TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrandLogo({
  href,
  size = "lg",
  className,
}: {
  href?: string;
  size?: "lg" | "sm";
  className?: string;
}) {
  const content = (
    <>
      <TrendingUp className="size-[22px] text-primary" strokeWidth={1.8} />
      <span
        className={cn(
          "font-display text-foreground",
          size === "lg" ? "text-lg" : "text-[17px]",
        )}
      >
        TrendOS
      </span>
    </>
  );
  const classes = cn("flex items-center gap-2.5", className);

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return <span className={classes}>{content}</span>;
}
