import { createFileRoute } from "@tanstack/react-router";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/iscae-config";
import { authenticateCaller, json, serverEnv } from "@/lib/iscae-server";
import {
  assertVapidUsable,
  endpointLabel,
  readVapidEnv,
  sendPushNotification,
  type StoredPushSubscription,
} from "@/lib/iscae-push";

/**
 * إشعارات اشتراك الخريجين (Web Push):
 *  - event = "submitted": الخريج أرسل طلب تحقق ← إشعار لمسؤول المالية (وللمشرف الرئيسي فقط إن لم يوجد مسؤول مالية).
 *  - event = "reviewed" (الافتراضي): مسؤول المالية/المشرف الرئيسي قبل الطلب أو رفضه ← إشعار للخريج.
 * القبول والرفض نفسه محصور في قاعدة البيانات (review_subscription_request) بمسؤول المالية والمشرف الرئيسي فقط.
 */
type Body = { promotion_id?: unknown; request_id?: unknown; event?: unknown };
type ReviewedRequest = {
  id: string;
  promotion_id: string;
  account_id: string;
  status: "approved" | "rejected" | "pending";
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at?: string | null;
};
type GraduateAccount = { id?: string; user_id: string; full_name?: string | null; registration_number?: string | null };
type GraduateNotification = { id: string; title: string; body: string; url: string | null };
type TargetSubscription = StoredPushSubscription & { lang: string | null };
type UserRow = { user_id: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBMITTED_WINDOW_MS = 15 * 60_000;
const recentSubmitted = new Map<string, number>();

function restHeaders(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

async function selectRows<T>(
  table: string,
  query: URLSearchParams,
  headers: Record<string, string>,
): Promise<T[] | null> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`, {
    headers,
    cache: "no-store",
  });
  if (!response.ok) return null;
  return (await response.json()) as T[];
}

type Built = { id?: string | null; title: string; body: string; lang: "fr" | "ar" };

/** يرسل الإشعار لقائمة الأجهزة على دفعات ويحذف الأجهزة المنتهية؛ يعيد استجابة JSON جاهزة. */
async function deliver(
  request: Request,
  promotionId: string,
  subscriptions: TargetSubscription[],
  headers: Record<string, string>,
  build: (subscription: TargetSubscription, french: boolean) => Built,
  label: string,
): Promise<Response> {
  if (!subscriptions.length) return json({ ok: true, total: 0, sent: 0, failed: 0 });

  const vapid = await readVapidEnv();
  if (!vapid) {
    return json({ ok: false, error: "PUSH_CONFIGURATION_UNAVAILABLE", total: subscriptions.length, sent: 0 }, 503);
  }
  try {
    await assertVapidUsable(vapid);
  } catch (error) {
    console.error("[Push] invalid VAPID keys for", label, error instanceof Error ? error.message : "unknown");
    return json({ ok: false, error: "PUSH_CONFIGURATION_UNAVAILABLE", total: subscriptions.length, sent: 0 }, 503);
  }

  const origin = new URL(request.url).origin;
  const goneIds: string[] = [];
  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < subscriptions.length; offset += 10) {
    const batch = subscriptions.slice(offset, offset + 10);
    const results = await Promise.all(
      batch.map(async (subscription) => {
        const french = !!subscription.lang?.toLowerCase().startsWith("fr");
        const built = build(subscription, french);
        const result = await sendPushNotification(
          subscription,
          {
            id: built.id || "",
            title: built.title,
            body: built.body,
            lang: built.lang,
            url: new URL("/site/index.html?graduate=1", origin).toString(),
          },
          vapid,
        );
        return { subscription, result };
      }),
    );
    for (const { subscription, result } of results) {
      if (result.outcome === "ok") sent += 1;
      else if (result.outcome === "gone") goneIds.push(subscription.id);
      else failed += 1;
    }
  }

  if (goneIds.length) {
    const deleteQuery = new URLSearchParams({ id: `in.(${goneIds.join(",")})` });
    const deleteResponse = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?${deleteQuery.toString()}`, {
      method: "DELETE",
      headers: { ...headers, Prefer: "return=minimal" },
    });
    if (!deleteResponse.ok) console.error("[Push] unable to remove expired subscriptions");
  }

  console.log(
    `[Push] ${label} promotion=${promotionId} devices=${subscriptions.length} sent=${sent} failed=${failed} expired=${goneIds.length}${subscriptions[0] ? ` endpoint=${endpointLabel(subscriptions[0].endpoint)}` : ""}`,
  );
  return json(
    { ok: failed === 0, total: subscriptions.length, sent, failed, removed: goneIds.length },
    failed === subscriptions.length ? 502 : 200,
  );
}

async function subscriptionsForUsers(
  userIds: string[],
  promotionId: string,
  headers: Record<string, string>,
): Promise<TargetSubscription[] | null> {
  if (!userIds.length) return [];
  const query = new URLSearchParams({
    select: "id,endpoint,p256dh,auth,lang",
    user_id: `in.(${userIds.join(",")})`,
    promotion_id: `eq.${promotionId}`,
    is_active: "eq.true",
    limit: "500",
  });
  return selectRows<TargetSubscription>("push_subscriptions", query, headers);
}

export const Route = createFileRoute("/api/public/push/graduate-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateCaller(request);
        if ("error" in auth) return auth.error;

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return json({ ok: false, error: "INVALID_REQUEST" }, 400);
        }
        const promotionId = String(body.promotion_id ?? "").trim();
        const requestId = String(body.request_id ?? "").trim();
        const event = body.event === "submitted" ? "submitted" : "reviewed";
        if (!UUID_RE.test(promotionId) || (requestId && !UUID_RE.test(requestId)) || (event === "reviewed" && !requestId)) {
          return json({ ok: false, error: "INVALID_REQUEST" }, 400);
        }

        const serviceKey = serverEnv("SUPABASE_SERVICE_ROLE_KEY") ?? serverEnv("SUPABASE_SERVICE_KEY");
        if (!serviceKey) return json({ ok: false, error: "PUSH_SERVICE_UNAVAILABLE" }, 503);
        const headers = restHeaders(serviceKey);

        /* ===== الخريج أرسل طلب اشتراك ← مسؤول المالية ===== */
        if (event === "submitted") {
          const accountQuery = new URLSearchParams({
            select: "id,user_id,full_name,registration_number",
            user_id: `eq.${auth.caller.userId}`,
            promotion_id: `eq.${promotionId}`,
            limit: "1",
          });
          const account = (await selectRows<GraduateAccount>("graduate_accounts", accountQuery, headers))?.[0];
          if (!account?.id) return json({ ok: false, error: "GRADUATE_ACCOUNT_NOT_FOUND" }, 404);

          const pendingQuery = new URLSearchParams({
            select: "id,promotion_id,account_id,status,reviewed_at,rejection_reason,created_at",
            account_id: `eq.${account.id}`,
            promotion_id: `eq.${promotionId}`,
            status: "eq.pending",
            order: "created_at.desc",
            limit: "1",
          });
          const pending = (await selectRows<ReviewedRequest>("subscription_requests", pendingQuery, headers))?.[0];
          if (!pending || !pending.created_at || Date.now() - new Date(pending.created_at).getTime() > SUBMITTED_WINDOW_MS) {
            return json({ ok: false, error: "PENDING_REQUEST_NOT_FOUND" }, 404);
          }
          // منع تكرار الإشعار لنفس الطلب (استدعاءات مكررة)
          const lastSent = recentSubmitted.get(pending.id);
          if (lastSent && Date.now() - lastSent < SUBMITTED_WINDOW_MS) return json({ ok: true, total: 0, sent: 0, failed: 0, duplicate: true });
          recentSubmitted.set(pending.id, Date.now());
          if (recentSubmitted.size > 500) recentSubmitted.clear();

          const staffQuery = new URLSearchParams({
            select: "user_id",
            promotion_id: `eq.${promotionId}`,
            role: "eq.finance",
            is_active: "eq.true",
            limit: "50",
          });
          let recipients = ((await selectRows<UserRow>("promotion_staff", staffQuery, headers)) ?? [])
            .map((row) => row.user_id)
            .filter((id): id is string => !!id);
          if (!recipients.length) {
            const platformQuery = new URLSearchParams({
              select: "user_id",
              is_platform: "eq.true",
              is_active: "eq.true",
              limit: "20",
            });
            recipients = ((await selectRows<UserRow>("admins", platformQuery, headers)) ?? [])
              .map((row) => row.user_id)
              .filter((id): id is string => !!id);
          }
          const subscriptions = await subscriptionsForUsers([...new Set(recipients)], promotionId, headers);
          if (subscriptions === null) return json({ ok: false, error: "PUSH_SUBSCRIPTIONS_UNAVAILABLE" }, 503);

          const who = [account.full_name, account.registration_number].filter(Boolean).join(" — ");
          return deliver(
            request,
            promotionId,
            subscriptions,
            headers,
            (_subscription, french) => ({
              id: pending.id,
              title: french ? "Nouvelle demande d’adhésion" : "طلب اشتراك مالي جديد",
              body: french
                ? `${who || "Un diplômé"} a envoyé une demande de vérification de paiement.`
                : `${who || "خريج"} أرسل طلب تحقق من الاشتراك. يرجى مراجعته.`,
              lang: french ? "fr" : "ar",
            }),
            "finance-new-request",
          );
        }

        /* ===== قرار مسؤول المالية/المشرف الرئيسي ← الخريج ===== */
        // الصلاحية: مسؤول المالية أو المشرف الرئيسي فقط (ليس رئيس الدفعة)
        const permission = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can_review_subscriptions`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${auth.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ _promotion_id: promotionId }),
          cache: "no-store",
        });
        if (!permission.ok || (await permission.json()) !== true) return json({ ok: false, error: "FORBIDDEN" }, 403);

        const requestQuery = new URLSearchParams({
          select: "id,promotion_id,account_id,status,reviewed_at,rejection_reason",
          id: `eq.${requestId}`,
          promotion_id: `eq.${promotionId}`,
          limit: "1",
        });
        const reviewed = (await selectRows<ReviewedRequest>("subscription_requests", requestQuery, headers))?.[0];
        if (!reviewed || !["approved", "rejected"].includes(reviewed.status) || !reviewed.reviewed_at) {
          return json({ ok: false, error: "REVIEWED_REQUEST_NOT_FOUND" }, 404);
        }

        const accountQuery = new URLSearchParams({
          select: "user_id",
          id: `eq.${reviewed.account_id}`,
          promotion_id: `eq.${promotionId}`,
          limit: "1",
        });
        const account = (await selectRows<GraduateAccount>("graduate_accounts", accountQuery, headers))?.[0];
        if (!account?.user_id) return json({ ok: false, error: "GRADUATE_ACCOUNT_NOT_FOUND" }, 404);

        const notificationQuery = new URLSearchParams({
          select: "id,title,body,url",
          promotion_id: `eq.${promotionId}`,
          user_id: `eq.${account.user_id}`,
          created_at: `gte.${reviewed.reviewed_at}`,
          order: "created_at.desc",
          limit: "1",
        });
        const notification = (await selectRows<GraduateNotification>("graduate_notifications", notificationQuery, headers))?.[0];
        if (!notification) return json({ ok: false, error: "STATUS_NOTIFICATION_NOT_FOUND" }, 404);

        const subscriptions = await subscriptionsForUsers([account.user_id], promotionId, headers);
        if (subscriptions === null) return json({ ok: false, error: "PUSH_SUBSCRIPTIONS_UNAVAILABLE" }, 503);

        const rejectedReason = reviewed.rejection_reason?.trim();
        return deliver(
          request,
          promotionId,
          subscriptions,
          headers,
          (_subscription, french) => {
            const approved = reviewed.status === "approved";
            return {
              id: notification.id,
              title: approved
                ? french ? "Adhésion approuvée" : "تم قبول الاشتراك"
                : french ? "Mise à jour de votre adhésion" : "تحديث طلب الاشتراك",
              body: approved
                ? french ? "Votre paiement a été vérifié et votre adhésion est activée." : notification.body
                : french ? `Votre paiement a été refusé.${rejectedReason ? ` Motif : ${rejectedReason}` : ""}` : notification.body,
              lang: french ? "fr" : "ar",
            };
          },
          "graduate-status",
        );
      },
    },
  },
});
