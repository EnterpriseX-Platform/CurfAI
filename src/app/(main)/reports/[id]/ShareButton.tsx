"use client";
/**
 * Mint a public share link for this report. The same PublicShareToken backs
 * both surfaces:
 *   - /share/<token>  - branded read-only viewer
 *   - /embed/<token>  - chromeless, iframe-friendly embed (frame-ancestors *)
 *
 * The button opens a small popover so the user can pick: copy a share URL,
 * copy an iframe snippet, or copy a chromeless embed URL.
 */
import { useState } from "react";
import { Globe, Loader2, Check, Code, Link as LinkIcon, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

type CopyKind = "share" | "embed-url" | "embed-iframe";

export function ShareButton({ reportId }: { reportId: string }) {
  const { push } = useToast();
  const { t } = useT();
  const [busy, setBusy] = useState<CopyKind | null>(null);

  async function mintAndCopy(kind: CopyKind) {
    setBusy(kind);
    try {
      const r = await fetch("/api/reports/" + reportId + "/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays: 30 }),
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* keep text */ }
        push({ variant: "destructive", title: t("shareButton.mintFailed"), description: msg });
        return;
      }
      const { token } = await r.json();
      const origin = window.location.origin;
      const shareUrl = origin + "/share/" + token;
      const embedUrl = origin + "/embed/" + token;
      const iframe = '<iframe src="' + embedUrl + '" style="border:0;width:100%;height:600px" loading="lazy"></iframe>';

      let payload = "";
      let title = "";
      let description = t("shareButton.expiresNote");
      switch (kind) {
        case "share":
          payload = shareUrl;
          title = t("shareButton.shareLinkCopied");
          break;
        case "embed-url":
          payload = embedUrl;
          title = t("shareButton.embedUrlCopied");
          description = t("shareButton.embedUrlHint") + description;
          break;
        case "embed-iframe":
          payload = iframe;
          title = t("shareButton.iframeCopied");
          description = t("shareButton.iframeHint") + description;
          break;
      }
      await navigator.clipboard.writeText(payload);
      push({ variant: "success", title, description });
    } finally {
      setBusy(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={busy !== null}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Globe className="mr-1.5 h-4 w-4" />}
          {t("shareButton.shareButton")}
          <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("shareButton.publicLinks")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); mintAndCopy("share"); }}>
          <LinkIcon className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span className="text-xs font-medium">{t("shareButton.copyShareLink")}</span>
            <span className="text-[10px] text-muted-foreground">{t("shareButton.copyShareLinkDesc")}</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("shareButton.embedSection")}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); mintAndCopy("embed-iframe"); }}>
          <Code className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span className="text-xs font-medium">{t("shareButton.copyIframeSnippet")}</span>
            <span className="text-[10px] text-muted-foreground">{t("shareButton.copyIframeSnippetDesc")}</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); mintAndCopy("embed-url"); }}>
          <Globe className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span className="text-xs font-medium">{t("shareButton.copyEmbedUrl")}</span>
            <span className="text-[10px] text-muted-foreground">{t("shareButton.copyEmbedUrlDesc")}</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
