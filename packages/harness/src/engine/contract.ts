import type {
  AgentInfo,
  ConsoleOrg,
  ConsoleState,
  McpResource,
  McpServer,
  MemoryInfo,
  PermissionV2Request,
  QuestionV2Request,
} from "../engine-types"
import type { ConfiguredProvider } from "../custom-provider"
import type { McpConfig, McpScope } from "../types"
import type {
  AssistantMessage,
  CommandV2Info,
  FileSystemEntry,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  McpStatusConnected,
  McpStatusDisabled,
  McpStatusFailed,
  McpStatusNeedsAuth,
  McpStatusNeedsClientRegistration,
  Message,
  Model,
  ModelV2Info,
  Part,
  PermissionSavedInfo,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderV2Info,
  QuestionV2Info,
  QuestionV2Tool,
  Session,
  SessionInputAdmitted,
  SessionMessagesResponse,
  SessionV2Info,
  SessionsResponse,
  SkillV2Info,
  VcsFileDiff,
  VcsFileStatus,
  VcsInfo,
} from "./sdk-types"

/**
 * What the app asks of an engine: one contract, implemented by the OpenCode 2 adapter (`v2.ts`).
 *
 * It was the 1.x adapter's inferred type until V2-71 removed that adapter, and it is written out here
 * so the app keeps the contract it was built against (ADR-0027). What 2.x removed is still declared,
 * and the adapter answers it with `UnsupportedByEngine` or an empty value (ADR-0026).
 */
type LocationInput = {
    location?: {
        directory?: string;
        workspace?: string;
    };
};
/** OpenCode 2's import of the 1.x history it was given, which runs once, when the engine starts. */
export type HistoryImportStatus = {
    status: "required" | "completed";
} | {
    status: "running";
    progress: {
        label: string;
        numerator?: number;
        denominator?: number;
    };
} | {
    status: "error";
    error: string;
};
/** A prompt the engine admitted and holds until the session can take it (V2-41). */
export type InboxPrompt = {
    id: string;
    text: string;
    files: Array<{
        uri: string;
        name: string;
    }>;
    delivery: "steer" | "queue";
};

export type EngineClient = {
    health: {
        /**
         * `/global/health` rather than the v2 one: only this route reports the engine's own version,
         * and everything that compares versions — the Engine row in Settings, the warning about a UI
         * generated against a different engine — was reading a field the v2 route never sends.
         */
        get: () => Promise<{
            healthy: boolean;
            version: string | undefined;
        }>;
    };
    /**
     * Drop the engine's cached instances so the next request re-reads its configuration.
     *
     * The engine resolves agents and skills once per instance and never reloads them, so a file
     * written afterwards — by the Agents panel, say — is on disk but not in a running session. This
     * is the same dispose the credential flow already uses, exposed so the reader can ask for it.
     * It disposes every instance, so turns in flight are dropped: callers confirm first.
     */
    reload: () => Promise<boolean>;
    event: {
        subscribe: (options?: {
            signal?: AbortSignal | undefined;
            idleTimeout?: number | undefined;
        } | undefined) => AsyncGenerator<{
            type?: string | undefined;
        }, void, unknown>;
        /** One folder's full event stream: legacy runs (chats) only stream their deltas and status here. */
        subscribeDirectory: (directory: string, options?: {
            signal?: AbortSignal | undefined;
            idleTimeout?: number | undefined;
        } | undefined) => AsyncGenerator<{
            type?: string | undefined;
        }, void, unknown>;
    };
    /** The engine's own folders; chats live in `state`, which always exists on the engine's machine. */
    paths: () => Promise<{
        home: string;
        state: string;
        config: string;
        directory: string;
    }>;
    /** The engine's settings, which decide when it folds a session: the meter reads the compaction
     *  ones. Only what this side asks for is typed; the rest of the config is the engine's. */
    config: () => Promise<{
        compaction?: {
            auto?: boolean | undefined;
            reserved?: number | undefined;
        } | undefined;
        flupcode?: {
            composeTools?: string[] | undefined;
            delivery?: Record<string, {
                composeTools?: string[] | undefined;
            }> | undefined;
            /** The repository `configFiles.export` copies global files into. */
            configRepo?: string | undefined;
        } | undefined;
    }>;
    /** The global config's provider lists, shared by every directory. */
    globalConfig: () => Promise<{
        disabled_providers?: string[] | undefined;
        provider?: Record<string, ConfiguredProvider> | undefined;
    }>;
    /** Writes back one key of the engine's config and leaves the rest as it is (H-25). */
    updateConfig: (patch: Record<string, unknown>) => Promise<void>;
    /** Writes back one key of the engine's global config, shared by every directory (H-25). */
    updateGlobalConfig: (patch: Record<string, unknown>) => Promise<void>;
    /** Re-reads the engine's config-derived state for a location, without disposing its instances. */
    reloadConfig: (input?: {
        directory?: string | undefined;
        workspace?: string | undefined;
    } | undefined) => Promise<void>;
    session: {
        /**
         * The engine's list, searched and paged server-side (H-18).
         *
         * `search` matches the title, `limit` bounds a page and the response's `cursor.next` is what a
         * reader loads the next one with. The old wrapper capped the list at 200 and never used either,
         * so a session older than the last 200 simply did not exist for this app.
         */
        list: (input?: {
            order?: "asc" | "desc" | undefined;
            limit?: number | undefined;
            search?: string | undefined;
            cursor?: string | undefined;
            directory?: string | undefined;
        } | undefined) => Promise<SessionsResponse>;
        create: (input?: {
            model?: {
                id: string;
                providerID: string;
                variant?: string | undefined;
            } | undefined;
            location?: {
                directory: string;
            } | undefined;
            agent?: string | undefined;
        } | undefined) => Promise<SessionV2Info>;
        prompt: (input: {
            sessionID: string;
            text: string;
            id?: string | undefined;
            files?: {
                uri: string;
                name?: string | undefined;
            }[] | undefined;
            delivery?: "queue" | "steer" | undefined;
        }) => Promise<{
            data: SessionInputAdmitted;
        }>;
        wait: (input: {
            sessionID: string;
        }) => Promise<void>;
        /**
         * The engine's compaction is `summarize`: it runs the model over the history and writes the
         * summary back. The v2 `compact` beside it is a stub that answers "not available yet".
         */
        compact: (input: {
            sessionID: string;
            directory?: string | undefined;
            providerID: string;
            modelID: string;
        }) => Promise<boolean>;
        /** Sessions whose run is still going, across all of its steps. */
        active: () => Promise<Set<string>>;
        /**
         * Sends a prompt. It returns as soon as the engine admitted it into the session inbox; the
         * event stream carries the rest. A prompt sent while a turn is running is delivered by the
         * engine (V2-41): a steer joins the turn at its next boundary, a queued one waits in the inbox.
         */
        send: (input: {
            sessionID: string;
            directory?: string | undefined;
            text: string;
            id?: string | undefined;
            agent?: string | undefined;
            /**
             * Named instructions the session runs under, which the engine keeps: an entry goes into the
             * system prompt, and when one changes later the engine appends the change instead of
             * rewriting it, so the prompt cache holds. A key left out is kept as it is; `undefined`
             * removes it.
             */
            instructions?: Record<string, string | undefined> | undefined;
            files?: {
                uri: string;
                name?: string | undefined;
            }[] | undefined;
            model?: {
                providerID: string;
                id: string;
                variant?: string | undefined;
            } | undefined;
            delivery?: "queue" | "steer" | undefined;
        }) => Promise<void>;
        /** The prompts a session's engine holds back until it can take them (V2-41). */
        inbox: {
            list: (_input: {
                sessionID: string;
            }) => Promise<InboxPrompt[]>;
            cancel: (_input: {
                sessionID: string;
                inboxID: string;
            }) => Promise<void>;
            update: (_input: {
                sessionID: string;
                inboxID: string;
                delivery: "queue" | "steer";
            }) => Promise<void>;
        };
        /** Which sessions of a folder the engine is working on (on 2.x, the active ones). */
        status: (input: {
            directory: string;
        }) => Promise<Set<string>>;
        /** Stops the turn running on this session: the engine's interrupt. */
        abort: (input: {
            sessionID: string;
            directory?: string | undefined;
        }) => Promise<void>;
        switchModel: (input: {
            sessionID: string;
            model: {
                id: string;
                providerID: string;
                variant?: string | undefined;
            };
        }) => Promise<void>;
        switchAgent: (input: {
            sessionID: string;
            agent: string;
        }) => Promise<void>;
        setPermission: (input: {
            sessionID: string;
            permission: {
                permission: string;
                pattern: string;
                action: "allow" | "ask" | "deny";
            }[];
            directory?: string | undefined;
        }) => Promise<SessionV2Info>;
        revert: {
            /** Stages a revert to a message; `commit` makes it final and `clear` drops it. */
            stage: (input: {
                sessionID: string;
                messageID: string;
                directory?: string | undefined;
            }) => Promise<Session>;
            clear: (input: {
                sessionID: string;
                directory?: string | undefined;
            }) => Promise<Session>;
            /** Drops the messages the staged revert hid, which is what the next prompt does on its own. */
            commit: (input: {
                sessionID: string;
                directory?: string | undefined;
            }) => Promise<boolean>;
        };
        permission: {
            list: (input: {
                sessionID: string;
            }) => Promise<{
                data: PermissionV2Request[];
            }>;
            reply: (input: {
                sessionID: string;
                requestID: string;
                reply: "always" | "once" | "reject";
                /** Shown to the agent when rejecting, so it can pick another way instead of guessing. */
                message?: string | undefined;
            }) => Promise<void>;
        };
        question: {
            list: (input: {
                sessionID: string;
            }) => Promise<{
                data: QuestionV2Request[];
            }>;
            reply: (input: {
                sessionID: string;
                requestID: string;
                answers: string[][];
            }) => Promise<void>;
            reject: (input: {
                sessionID: string;
                requestID: string;
            }) => Promise<void>;
        };
        rename: (input: {
            sessionID: string;
            title: string;
        }) => Promise<Session>;
        remove: (input: {
            sessionID: string;
        }) => Promise<boolean>;
        fork: (input: {
            sessionID: string;
            messageID?: string | undefined;
        }) => Promise<SessionV2Info>;
        shell: (input: {
            sessionID: string;
            command: string;
        }) => Promise<{
            info: Message;
            parts: Part[];
        }>;
        command: (input: {
            sessionID: string;
            command: string;
            arguments?: string | undefined;
        }) => Promise<{
            info: AssistantMessage;
            parts: Part[];
        }>;
        /**
         * Runs a skill. The engine has no endpoint for this: a skill is something the agent loads
         * with its `skill` tool, so asking for one is a prompt that names it. The prompt below is what
         * the TUI sends, and the agent answers it by loading the skill's instructions.
         */
        skill: (input: {
            sessionID: string;
            skill: string;
            arguments?: string | undefined;
        }) => Promise<{
            data: SessionInputAdmitted;
        }>;
        move: (input: {
            sessionID: string;
            directory: string;
        }) => Promise<void>;
        children: (input: {
            sessionID: string;
        }) => Promise<{
            data: SessionV2Info[];
        }>;
        /** The engine's own todo store, which the todowrite tool keeps and the transcript may prune. */
        todos: (input: {
            sessionID: string;
            directory?: string | undefined;
        }) => Promise<{
            data: {
                content: string;
                status: string;
            }[];
        }>;
    };
    message: {
        list: (input: {
            sessionID: string;
            order?: "asc" | "desc" | undefined;
        }) => Promise<SessionMessagesResponse>;
    };
    suggest: {
        /** The configured `small_model` ("provider/model"), when the user set one. */
        smallModel: () => Promise<{
            providerID: string;
            id: string;
        } | undefined>;
        /**
         * Predicts the user's next message from the end of a conversation. The engine has no
         * session-less completion, so this runs one prompt in a throwaway child session (hidden from
         * the session list, no tools, no title call) and deletes it.
         */
        reply: (input: {
            parentID: string;
            directory?: string | undefined;
            model: {
                providerID: string;
                id: string;
                variant?: string | undefined;
            };
            prompt: string;
            system: string;
        }) => Promise<string>;
    };
    model: {
        list: (input?: LocationInput | undefined) => Promise<{
            data: ModelV2Info[];
        }>;
        directory: () => Promise<{
            providers: Provider[];
            default: {
                [key: string]: string;
            };
        }>;
        default: () => Promise<{
            data: ModelV2Info | undefined;
        }>;
    };
    provider: {
        list: (input?: LocationInput | undefined) => Promise<{
            data: ProviderV2Info[];
        }>;
        /**
         * The engine answers this one with every configured API key in the clear. Nothing in the UI
         * needs the key itself, and over remote control the answer crosses to a phone, so the keys are
         * dropped here and never reach app state, a component prop or another device.
         */
        directory: () => Promise<{
            default: {
                [key: string]: string;
            };
            connected: string[];
            all: {
                id: string;
                name: string;
                source: "api" | "config" | "custom" | "env";
                env: string[];
                options: {
                    [key: string]: unknown;
                };
                models: {
                    [key: string]: Model;
                };
            }[];
        }>;
        auth: () => Promise<{
            [key: string]: ProviderAuthMethod[];
        }>;
        /**
         * The engine's legacy provider OAuth, the one the TUI uses. A stock OpenCode CLI registers
         * Copilot's device flow here but not in the v2 integration registry, so the panel falls back
         * to this when a provider advertises an OAuth method in `provider.auth()` and the integration
         * has none. `callback` blocks until the provider authorizes (device flow) and stores the
         * credential itself; unlike the v2 attempt there is no cancel, so it keeps polling server-side.
         */
        oauth: {
            authorize: (input: {
                providerID: string;
                method: number;
                inputs?: Record<string, string> | undefined;
            }) => Promise<ProviderAuthAuthorization>;
            callback: (input: {
                providerID: string;
                method: number;
                code?: string | undefined;
            }) => Promise<boolean>;
        };
        /**
         * Registers the API keys already in the engine's own configuration as v2 credentials, which is
         * what makes those providers usable by v2 sessions. The keys stay inside this call: the reader
         * asks for it from the providers panel, it is never done on its own.
         */
        linkConfiguredKeys: () => Promise<number>;
        /** Providers whose configured key is not a v2 credential yet, by id; never carries the key. */
        unlinked: () => Promise<string[]>;
    };
    auth: {
        set: (input: {
            providerID: string;
            key: string;
        }) => Promise<boolean>;
        remove: (input: {
            providerID: string;
        }) => Promise<boolean>;
        /**
         * The engine resolves providers once and caches them, key included, so a credential saved
         * afterwards is written but never used: requests keep going out with the previous key.
         * Disposing drops that cached state so the next request reads the credentials again.
         */
        reload: () => Promise<boolean>;
    };
    integration: {
        list: () => Promise<{
            data: IntegrationInfo[];
        }>;
        connectKey: (input: {
            integrationID: string;
            key: string;
            label?: string | undefined;
        }) => Promise<void>;
        oauth: (input: {
            integrationID: string;
            methodID?: string | undefined;
            inputs?: Record<string, string> | undefined;
            label?: string | undefined;
        }) => Promise<{
            data: IntegrationAttempt;
        }>;
        attempt: {
            status: (attemptID: string) => Promise<{
                data: IntegrationAttemptStatus;
            }>;
            cancel: (attemptID: string) => Promise<void>;
        };
        disconnect: (credentialID: string) => Promise<void>;
    };
    /**
     * The Console org behind providers (CO-1): which org is active, which can become active,
     * and the switch. Absent Console means these answer empty, and the UI stays as it was.
     */
    console: {
        active: () => Promise<ConsoleState>;
        orgs: () => Promise<ConsoleOrg[]>;
        switchOrg: (input: {
            accountID: string;
            orgID: string;
        }) => Promise<boolean>;
    };
    /**
     * Blocked work, from whichever runtime owns it. A request belongs to the runtime that raised it
     * and can only be answered there: the legacy runner — the one every Code and Chat turn runs on —
     * keeps its own registry at `/question` and `/permission`, and the v2 ones answer empty for it.
     * Reading only v2 is what left an agent waiting on a question no dock could show.
     */
    blocked: {
        questions: (input: {
            directory?: string | undefined;
            sessionID?: string | undefined;
        }) => Promise<{
            id: string;
            sessionID: string;
            tool?: QuestionV2Tool | undefined;
            questions: QuestionV2Info[];
        }[]>;
        permissions: (input: {
            directory?: string | undefined;
            sessionID?: string | undefined;
        }) => Promise<PermissionV2Request[]>;
        answerQuestion: (input: {
            requestID: string;
            directory?: string | undefined;
            answers: string[][];
        }) => Promise<boolean>;
        rejectQuestion: (input: {
            requestID: string;
            directory?: string | undefined;
        }) => Promise<boolean>;
        answerPermission: (input: {
            requestID: string;
            directory?: string | undefined;
            reply: "always" | "once" | "reject";
            message?: string | undefined;
        }) => Promise<boolean>;
    };
    /** Permissions across every session, and the ones the reader told the engine to remember. */
    permission: {
        /** Everything waiting for an answer, not just the open session's: a blocked agent is silent. */
        pending: (input?: LocationInput | undefined) => Promise<{
            data: PermissionV2Request[];
        }>;
        saved: {
            list: (input?: {
                projectID?: string | undefined;
            } | undefined) => Promise<{
                data: PermissionSavedInfo[];
            }>;
            remove: (input: {
                id: string;
            }) => Promise<void>;
        };
    };
    agent: {
        list: (input?: LocationInput | undefined) => Promise<{
            data: AgentInfo[];
        }>;
        /**
         * The agents this folder actually has (H-13), through the legacy `/agent?directory=`, which is
         * the list the engine reads those files with.
         */
        listFor: (directory?: string | undefined) => Promise<AgentInfo[]>;
    };
    command: {
        list: (input?: LocationInput | undefined) => Promise<{
            data: CommandV2Info[];
        }>;
    };
    /** Every tool the engine offers, by id (H-17). */
    tools: () => Promise<string[]>;
    skill: {
        list: (input?: LocationInput | undefined) => Promise<{
            data: SkillV2Info[];
        }>;
    };
    /** Where OpenCode 2 is in importing 1.x history (V2-61); 1.x imports nothing. */
    migration: {
        status: () => Promise<HistoryImportStatus | undefined>;
    };
    memory: {
        list: (input?: {
            location?: {
                directory?: string | undefined;
            } | undefined;
            text?: string | undefined;
            scope?: "agent" | "global" | "project" | "session" | undefined;
            status?: "active" | "archived" | "candidate" | "stale" | undefined;
            sessionID?: string | undefined;
            agent?: string | undefined;
            limit?: number | undefined;
        } | undefined) => Promise<{
            data: MemoryInfo[];
        }>;
        get: (input: {
            id: string;
        }) => Promise<{
            data: MemoryInfo;
        }>;
        create: (input: {
            scope?: "agent" | "global" | "project" | "session" | undefined;
            kind?: "constraint" | "convention" | "decision" | "fact" | "issue" | "preference" | "procedure" | "solution" | "workflow" | undefined;
            title: string;
            content: string;
            tags?: string[] | undefined;
            status?: "active" | "archived" | "candidate" | "stale" | undefined;
            confidence?: number | undefined;
            importance?: number | undefined;
            source?: "agent_discovery" | "agent_tool" | "conversation" | "explicit_user" | "import" | "manual" | "repository_file" | "tool_result" | undefined;
            sessionID?: string | undefined;
            agent?: string | undefined;
        }) => Promise<{
            data: MemoryInfo;
        }>;
        update: (input: {
            id: string;
            title?: string | undefined;
            content?: string | undefined;
            kind?: "constraint" | "convention" | "decision" | "fact" | "issue" | "preference" | "procedure" | "solution" | "workflow" | undefined;
            tags?: string[] | undefined;
            status?: "active" | "archived" | "candidate" | "stale" | undefined;
            confidence?: number | undefined;
            importance?: number | undefined;
        }) => Promise<{
            data: MemoryInfo;
        }>;
        remove: (input: {
            id: string;
        }) => Promise<void>;
        verify: (input: {
            id: string;
        }) => Promise<{
            data: MemoryInfo;
        }>;
        used: (input: {
            sessionID: string;
        }) => Promise<{
            data: MemoryInfo[];
        }>;
    };
    file: {
        find: (input: {
            query: string;
            limit?: number | undefined;
        }) => Promise<{
            data: FileSystemEntry[];
        }>;
        /**
         * Lists one directory level. The engine only lists inside a location, so the folder browser
         * passes the folder it browses from as the location and walks it with relative paths.
         */
        list: (input: {
            directory: string;
            path?: string | undefined;
        }) => Promise<FileSystemEntry[]>;
    };
    vcs: {
        get: (directory: string) => Promise<VcsInfo>;
        status: (directory: string) => Promise<VcsFileStatus[]>;
        /**
         * Changed files with their patches.
         *
         * `context` matters more than it looks. Without it the engine answers with the whole file as
         * one hunk: measured against a real repository, an eight-line change in a 250-line file came
         * back as 254 rows of patch, 246 of them unchanged. Three lines either side is what every
         * other diff starts at, and the viewer can ask for the rest.
         *
         * `mode` picks the question: "git" is the working tree against HEAD, "branch" is this branch
         * against the default one — the only one that still answers after a run commits.
         */
        diff: (directory: string, options?: {
            mode?: "branch" | "git" | undefined;
            context?: number | undefined;
        }) => Promise<VcsFileDiff[]>;
    };
    /**
     * MCP servers. The engine's `/mcp` routes drive the running instance, while the servers
     * themselves live in the configuration, so adding and removing one writes there as well —
     * otherwise a server added here would be gone the next time the engine started. Every call in
     * here used to be a no-op behind a working-looking panel.
     *
     * Every call takes the directory the list was read for. Without one the engine acts on the
     * instance of its own working directory, so a server connected, authorized or added to the
     * project from the panel could land in a different instance than the one the panel shows.
     */
    mcp: {
        list: (input?: {
            directory?: string | undefined;
        } | undefined) => Promise<{
            data: McpServer[];
        }>;
        /** The configured servers themselves, so the form can open one for editing instead of guessing. */
        config: (input?: {
            directory?: string | undefined;
        } | undefined) => Promise<{
            data: Record<string, McpConfig>;
        }>;
        add: (input: {
            server: string;
            config: McpConfig;
            scope?: McpScope | undefined;
            directory?: string | undefined;
        }) => Promise<void>;
        remove: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<void>;
        connect: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<boolean>;
        disconnect: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<boolean>;
        /**
         * OAuth for a server that needs it (SE-2): start returns the URL to open, authenticate
         * waits for the engine's callback, remove forgets the credentials.
         */
        authStart: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<{
            authorizationUrl: string;
            oauthState: string;
        }>;
        authenticate: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<McpStatusConnected | McpStatusDisabled | McpStatusFailed | McpStatusNeedsAuth | McpStatusNeedsClientRegistration>;
        /** 1.x's sign-in always comes back through the engine's callback; a pasted code is 2.x's. */
        authComplete: (_input: {
            server: string;
            code: string;
            directory?: string | undefined;
        }) => Promise<void>;
        authRemove: (input: {
            server: string;
            directory?: string | undefined;
        }) => Promise<{
            success: true;
        }>;
        /**
         * What the connected servers expose (H-34).
         *
         * The engine never lists an MCP server's **tools** — they bypass its registry, so only the
         * calls it makes are known, which is what the context panel reads. Resources it does report.
         */
        resources: (input?: {
            directory?: string | undefined;
        } | undefined) => Promise<McpResource[]>;
    };
};
