import Foundation

/// In-memory mailbox for UI tests. Never written to the Keychain and never enables test mode.
public enum UITestFixtures {
    public static let mailbox = "lojo@cyberphysical.us"
    public static let enablesTestMode = false
    public static let writesEnvelopeKey = false
    public static let deletesEnvelopeKey = false
    public static let persistsSession = false

    public static let threadId = "thr_uitest_gate"
    public static let messageId = "msg_uitest_gate"
    public static let draftId = "drf_uitest_queue"
    public static let sentDraftId = "drf_uitest_sent"

    public static func session() -> Session {
        Session(sessionToken: "hs_uitest.fixture", expiresAt: "2099-01-01T00:00:00.000Z")
    }

    public static func settings() throws -> ServerSettings {
        try decode("""
        {"mailbox":"lojo@cyberphysical.us","domain":"cyberphysical.us","llmProvider":"grok","dailyTokenBudget":200000,"budgetUsed":1200,"unlocked":true,"envelopeKeyFingerprint":"aaaa-bbbb-cccc-dddd","draftAttachments":{"maxMessageBytes":4000000,"maxFiles":10},"dev":false,"principal":"human"}
        """)
    }

    public static func inbox() throws -> [Message] {
        try decodeMessages("""
        [
          {"id":"msg_uitest_gate","threadId":"thr_uitest_gate","folder":"inbox","origin":"inbound","from":{"email":"ada@example.com","name":"Ada"},"to":[{"email":"lojo@cyberphysical.us"}],"cc":[],"subject":"Gate sensor","date":"2026-10-15T14:05:00.000Z","snippet":"The north gate is back online.","unread":true,"labels":[],"attachments":[{"id":"att_uitest","filename":"gate.jpg","contentType":"image/jpeg","size":24000}],"bulk":false,"pgpEncrypted":false,"ai":{"priority":"later","phishingScore":0},"locked":false,"text":"The north gate is back online. No action needed.","verdicts":{"dmarc":"pass","spf":"pass","dkim":"pass"}},
          {"id":"msg_uitest_news","threadId":"thr_uitest_news","folder":"inbox","origin":"inbound","from":{"email":"news@northwind.example","name":"Northwind"},"to":[{"email":"lojo@cyberphysical.us"}],"subject":"Weekly notes","date":"2026-10-14T09:00:00.000Z","snippet":"This week's newsletter.","unread":false,"labels":[],"attachments":[],"locked":false,"text":"This week's newsletter from Northwind."}
        ]
        """)
    }

    public static func sent() throws -> [Message] {
        try decodeMessages("""
        [
          {"id":"msg_uitest_sent","threadId":"thr_uitest_sent","folder":"sent","origin":"sent","from":{"email":"lojo@cyberphysical.us"},"to":[{"email":"lojo-test@cyberphysical.us"}],"subject":"Re: Gate sensor","date":"2026-10-13T18:00:00.000Z","snippet":"Thanks — I see it.","unread":false,"labels":[],"attachments":[],"locked":false,"text":"Thanks — I see it."}
        ]
        """)
    }

    public static func trash() throws -> [Message] {
        try decodeMessages("""
        [
          {"id":"msg_uitest_trash","threadId":"thr_uitest_trash","folder":"trash","origin":"inbound","from":{"email":"bulk@example.com"},"to":[{"email":"lojo@cyberphysical.us"}],"subject":"Old flyer","date":"2026-10-10T12:00:00.000Z","snippet":"You can restore this.","unread":false,"labels":[],"attachments":[],"locked":false,"text":"You can restore this.","trashedBy":"human","keepUntil":"2026-11-09T12:00:00.000Z"}
        ]
        """)
    }

    public static func thread(_ id: String) throws -> [Message] {
        let all = try inbox() + sent() + trash()
        let matches = all.filter { $0.threadId == id }
        if !matches.isEmpty { return matches }
        return try inbox()
    }

    public static func drafts() throws -> [DraftView] {
        [
            try decode("""
            {"draft":{"id":"drf_uitest_queue","to":[{"email":"ada@example.com"}],"cc":[],"subject":"Re: Gate sensor","status":"pending_approval","origin":"ai","lastEditedBy":"ai","aiGenerated":true,"pgp":"auto","createdAt":"2026-10-15T14:20:00.000Z","updatedAt":"2026-10-15T14:20:00.000Z"},"text":"Thanks Ada — I see the gate is back online."}
            """),
            try decode("""
            {"draft":{"id":"drf_uitest_sent","to":[{"email":"lojo-test@cyberphysical.us"}],"cc":[],"subject":"Sent earlier","status":"sent","origin":"human","pgp":"auto","createdAt":"2026-10-13T18:00:00.000Z","updatedAt":"2026-10-13T18:00:00.000Z","sentMessageId":"msg_uitest_sent"},"text":"Thanks — I see it."}
            """),
        ]
    }

    public static func rules() throws -> RulesState {
        try decode("""
        {"rules":{"version":1,"paused":false,"killSwitch":false,"sendKillSwitch":false,"siKillSwitch":false,"trashRetentionDays":30,"maxAutoSendPerDay":20,"rules":[{"id":"r_ack","name":"Ack known senders","enabled":true,"match":{"from":["@example.com"]},"actions":[{"type":"reply","reply":{"mode":"draft","template":"Thanks","maxChars":400}},{"type":"label","labels":["ack"]}],"stop":false,"createdBy":"human","updatedAt":"2026-10-01T00:00:00Z"}],"updatedAt":"2026-10-15T00:00:00.000Z","updatedBy":"human"},"autoSendEnabled":false}
        """)
    }

    public static func filterResult() -> SiFilterResult {
        SiFilterResult(killSwitch: false, proposals: [
            SiProposal(
                messageId: messageId,
                from: "news@northwind.example",
                domain: "northwind.example",
                subject: "Weekly notes",
                reason: "Looks like a newsletter.",
                actions: [SiAction(type: "label", labels: ["newsletters"])],
                saveRule: false
            ),
        ])
    }

    public static func blocked() -> [SiBlock] {
        [
            SiBlock(ruleId: "si-block-sender-news", kind: "sender", value: "ads@example.com", name: "SI block"),
        ]
    }

    public static func body(for message: Message) -> SealedBody {
        SealedBody(
            text: message.text ?? message.snippet ?? "",
            ai: SealedBody.AI(summary: "The north gate is back online.", threadSummary: "Ada reported the gate is working.", actionItems: [ActionItem(text: "None")], phishingReasons: [])
        )
    }

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private static func decodeMessages(_ json: String) throws -> [Message] {
        try decode(json)
    }
}
