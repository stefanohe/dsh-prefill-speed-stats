/**
 * Browser half of `dsh-prefill-speed-stats`.
 *
 * ## Registration
 *
 * This is a CLASSIC SCRIPT registering a lazy CJS factory on the global module
 * loader, the form every shipped bundle uses: the loader inserts a `<script>`
 * and looks the package name up in its factory table afterwards.
 *
 * `dsh-client-modules` snapshots the bundle BYTES when it composes the boot
 * graph and serves that buffer; `?rev=` is only a cache key, never a content
 * check. Editing this file therefore changes nothing for a running application
 * until it is FULLY RESTARTED — a browser refresh and a plugin disable/enable
 * cycle both failed to pick up an edit here.
 *
 * ## What it renders
 *
 * One dock cell beside the shipped session-statistics strip: the prefill speed
 * alone, opening a two-row dialog. Formatting, geometry and placement are
 * copied from the shipped surface (`packages/client/ui-chat/src/client/chat/`
 * `StatsPills.tsx`, `stat-dialog.ts`, `stat-dialog.module.css`) so the two read
 * as one row.
 *
 * ## Why the whole bundle is one IIFE
 *
 * A combo script concatenates SEVERAL packages' `client.js` into one classic
 * script, and classic scripts share the global lexical scope. A top-level
 * `const`/`let` here collides with the same identifier in any other hand-written
 * bundle: the browser throws
 * `Uncaught SyntaxError: Identifier 'X' has already been declared`, NOTHING in
 * that script registers, and the boot audit refuses the whole startup with
 * `<package>: import failed`. Shipped bundles never leak because their build
 * wraps the CJS output; a hand-written bundle has to wrap itself, and this one
 * does.
 */
(function () {
const loader = typeof window === "undefined" ? undefined : window.__ModuleLoader__;

if (loader === undefined || loader === null || typeof loader.load !== "function") {
	report("module loader is absent; the bundle registered nothing");
} else {
	loader.load({
		id: "dsh-prefill-speed-stats",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;

			try {
				build(require, exports);
			} catch (error) {
				// An inert plugin still activates, which keeps the boot audit satisfied:
				// the application refuses to start when any entry fails to activate.
				reportOnce("build", "bundle body failed, staying inert: " + describeError(error));
				exports.apply = function apply() {};
				exports.inject = [];
			}

			return module.exports;
		}
	});
}

/** @param {string} message */
function report(message) {
	try {
		// eslint-disable-next-line no-console
		console.warn("[prefill-speed-stats] " + message);
	} catch (ignored) {
		// A console that throws is not worth a second thought.
	}
}

/** @param {unknown} error */
function describeError(error) {
	if (error === null || error === undefined) return String(error);
	return error.message === undefined ? String(error) : String(error.message);
}

/** One warning per key per page: a broken strip must not spam the console. */
const REPORTED = new Set();

/** @param {string} key @param {string} message */
function reportOnce(key, message) {
	if (REPORTED.has(key)) return;
	REPORTED.add(key);
	report(message);
}

/**
 * The module body.
 *
 * @param {(specifier: string) => any} require
 * @param {any} exports
 */
function build(require, exports) {
	const React = require("react");
	if (React === undefined || React === null || typeof React.createElement !== "function") {
		throw new Error("react did not resolve to a React runtime");
	}
	// `react-dom` is a platform seed word. The dialog is portaled to
	// `document.body` exactly as the shipped one is: inside the composer's
	// stacking and transform contexts a `position: fixed` child would be placed
	// against the wrong box.
	const createPortal = (() => {
		try {
			const reactDom = require("react-dom");
			return reactDom !== null && typeof reactDom.createPortal === "function" ? reactDom.createPortal : null;
		} catch (error) {
			return null;
		}
	})();

	/** The dock cell. A fresh id ADDS an entry beside the shipped `stats` entry. */
	const SLOT = "conversation.composer.dock";
	const SLOT_ID = "prefill-speed";
	/** The shipped strip registered with order 0; a negative order sits LEFT of it. */
	const SLOT_ORDER = -1;
	/** The projection this strip reads; registered by this package's Host half. */
	const PROJECTION = "sessionSpeed";

	/**
	 * Stylesheet, rendered by the component itself (the inline `<style>` element
	 * also keeps the sheet alive without a styles service). Values are copied from
	 * the two shipped sheets: `StatsPills.module.css` for the pill and
	 * `stat-dialog.module.css` for the dialog, whose title row has no close button.
	 */
	const CSS =
		".dshpfs_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}" +
		".dshpfs_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}" +
		".dshpfs_pill svg{flex:none;width:14px;height:14px}" +
		".dshpfs_pill:hover,.dshpfs_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}" +
		".dshpfs_label{text-overflow:ellipsis;min-width:0;overflow:hidden}" +
		".dshpfs_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}" +
		".dshpfs_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}" +
		".dshpfs_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}" +
		".dshpfs_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}" +
		".dshpfs_titleLabel svg{flex:none;width:14px;height:14px}" +
		".dshpfs_details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}" +
		".dshpfs_details dt,.dshpfs_details dd{min-width:0;margin:0}" +
		".dshpfs_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}";

	/** Viewport margin the placement clamp keeps, and the gap above the trigger. */
	const PANEL_MARGIN = 12;
	const PANEL_GAP = 8;
	/** Unplaced portal panel: hidden but laid out so the clamp can measure it. */
	const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

	const DICTIONARIES = {
		zh: {
			title: "输入统计",
			average: "输入速度（会话平均）",
			realtime: "输入速度（{steps}）",
			stepsOne: "最近一步",
			stepsMany: "最近{count}步",
			numerals: ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"],
			unit: "tok/s"
		},
		en: {
			title: "Prefill statistics",
			average: "Prefill speed (session average)",
			realtime: "Prefill speed ({steps})",
			stepsOne: "last step",
			stepsMany: "last {count} steps",
			// Arabic digits: the Chinese numerals belong to the Chinese row only.
			numerals: null,
			unit: "tok/s"
		}
	};

	/**
	 * The window phrase for a step count: `最近一步`, `最近三步`, … `最近十步` in
	 * Chinese (which spells these counts out), `last 3 steps` in English (which does
	 * not). A language without a numeral table falls back to digits.
	 *
	 * A short session is not an error state, so the row states the count it really
	 * averaged. The projection publishes `null` until one step has closed, so zero
	 * should not reach here — the singular phrase is the defended fallback, because
	 * a slightly wrong label costs a reading while a throw costs the session.
	 *
	 * @param {any} t @param {number} steps
	 */
	function stepsPhrase(t, steps) {
		if (!Number.isFinite(steps) || steps <= 1) return t.stepsOne;
		const count = Math.floor(steps);
		const numerals = Array.isArray(t.numerals) ? t.numerals : null;
		const numeral = numerals !== null && count < numerals.length ? numerals[count] : String(count);
		return t.stepsMany.split("{count}").join(numeral);
	}

	/**
	 * The strip is a slot occupant, so it receives no translator. The language is
	 * read from the document at render time, which also follows a locale switch.
	 */
	function copy() {
		try {
			const explicit = typeof document === "undefined" ? null : document.documentElement.getAttribute("lang");
			const tag = explicit === null || explicit === undefined ? (typeof navigator === "undefined" ? null : navigator.language) : explicit;
			return String(tag === null || tag === undefined ? "en" : tag).toLowerCase().indexOf("zh") === 0 ? DICTIONARIES.zh : DICTIONARIES.en;
		} catch (error) {
			return DICTIONARIES.en;
		}
	}

	/**
	 * Throughput figure, copied from the shipped `formatTokensPerSecond`: whole
	 * tokens from ten up, one decimal below. `null` means "not measured", which
	 * renders as a placeholder rather than a zero.
	 *
	 * @param {number|null} tps
	 */
	function formatTps(tps) {
		if (tps === null || tps === undefined || !Number.isFinite(tps)) return "—";
		const clamped = Math.max(0, tps);
		return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
	}

	/**
	 * tokens per second, or `null` when the denominator is not a usable
	 * measurement.
	 *
	 * @param {number} tokens
	 * @param {number} ms
	 */
	function rate(tokens, ms) {
		return Number.isFinite(tokens) && Number.isFinite(ms) && ms > 0 ? (tokens / ms) * 1000 : null;
	}

	/**
	 * Pencil outline: writing = input. Drawn inline because a bundle may not
	 * require a Harness Client package; the parent rule sizes it to 14x14 and the
	 * geometry matches the shipped icon set's 1.5-on-16 box.
	 */
	function pencilIcon() {
		return React.createElement(
			"svg",
			{ viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", "aria-hidden": true },
			React.createElement("path", {
				d: "M10.6 2.9a1.35 1.35 0 0 1 1.9 0l.6.6a1.35 1.35 0 0 1 0 1.9l-6.6 6.6-2.9.9.9-2.9 6.1-7.1Z",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinejoin: "round"
			}),
			React.createElement("path", {
				d: "M9.4 4.1 12 6.7",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round"
			})
		);
	}

	function detailRow(key, label, value) {
		return [
			React.createElement("dt", { key: key + "-k" }, label),
			React.createElement("dd", { key: key + "-v" }, value)
		];
	}

	/**
	 * The strip: the session-average prefill speed, opening a two-row dialog.
	 *
	 * Both readings come from the same operands — uncached prompt tokens over
	 * summed first-token latency — and differ only in which steps they sum over:
	 * the whole log, and the last `window` closed steps.
	 */
	function PrefillSpeedStrip(props) {
		const useProjection = props === undefined || props === null ? undefined : props.useProjection;
		const speed = typeof useProjection === "function" ? useProjection(PROJECTION) : undefined;
		const state = React.useState(false);
		const open = state[0];
		const setOpen = state[1];
		const positionState = React.useState(null);
		const position = positionState[0];
		const setPosition = positionState[1];
		const rootRef = React.useRef(null);
		const panelRef = React.useRef(null);

		React.useEffect(
			function () {
				if (!open) return undefined;

				/**
				 * Place the portaled dialog above the trigger and clamp it inside the
				 * viewport: measure its real height first, then position. Mirrors
				 * `useAnchoredPosition({ side: 'top', gap: 8, margin: 12 })`.
				 */
				const reposition = function () {
					try {
						const anchor = rootRef.current;
						const panel = panelRef.current;
						const view = typeof window === "undefined" ? undefined : window;
						if (anchor === null || panel === null || view === undefined) return;
						const rect = anchor.getBoundingClientRect();
						const width = panel.offsetWidth;
						const height = panel.offsetHeight;
						const left = Math.min(
							Math.max(PANEL_MARGIN, rect.left + rect.width / 2 - width / 2),
							Math.max(PANEL_MARGIN, view.innerWidth - width - PANEL_MARGIN)
						);
						const top = Math.max(PANEL_MARGIN, rect.top - PANEL_GAP - height);
						setPosition({ left: Math.round(left) + "px", top: Math.round(top) + "px" });
					} catch (error) {
						reportOnce("position", "dialog positioning failed: " + describeError(error));
					}
				};

				reposition();
				// The first pass runs before layout settles; one more frame is enough for
				// the dialog's real height to exist.
				const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(reposition) : 0;

				const onPointerDown = (event) => {
					try {
						const anchor = rootRef.current;
						const panel = panelRef.current;
						const inside = (anchor !== null && anchor.contains(event.target)) || (panel !== null && panel.contains(event.target));
						if (!inside) setOpen(false);
					} catch (error) {
						setOpen(false);
					}
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};

				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				window.addEventListener("resize", reposition);
				window.addEventListener("scroll", reposition, true);
				return function () {
					if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
					window.removeEventListener("resize", reposition);
					window.removeEventListener("scroll", reposition, true);
				};
			},
			[open]
		);

		const t = copy();
		const session = speed === undefined || speed === null ? undefined : speed.session;
		const realtime = speed === undefined || speed === null ? undefined : speed.realtime;

		/**
		 * Algorithm 1 — session average:
		 *   Σ uncached tokens over the whole log / Σ those steps' prefill windows.
		 * The Host sums measured steps only, so both operands describe one step set.
		 */
		const averageTps = session === undefined ? null : rate(session.uncachedInputTokens, session.ttftMs);

		/**
		 * Algorithm 2 — the last N steps: the same ratio over the last `window`
		 * measured steps, or over every one when the session has fewer. The Host
		 * publishes the window's sums, so this stays a division rather than a fold,
		 * and the row names the actual count instead of claiming a full window.
		 */
		const realtimeTps = realtime === undefined || realtime === null ? null : rate(realtime.uncachedInputTokens, realtime.ttftMs);
		const realtimeSteps = realtime === undefined || realtime === null ? 0 : realtime.steps;
		const realtimeLabel = t.realtime.split("{steps}").join(stepsPhrase(t, realtimeSteps));

		const averageText = formatTps(averageTps) + " " + t.unit;

		let panel = null;
		if (open && typeof document !== "undefined") {
			try {
				const body = React.createElement(
					"div",
					{
						ref: panelRef,
						className: "dshpfs_panel",
						role: "dialog",
						"aria-label": t.title,
						style: position === null ? MEASURE_STYLE : position
					},
					React.createElement(
						"div",
						{ className: "dshpfs_title" },
						React.createElement("span", { className: "dshpfs_titleLabel" }, pencilIcon(), t.title)
					),
					React.createElement("div", { className: "dshpfs_titleRule", "aria-hidden": true }),
					React.createElement(
						"dl",
						{ className: "dshpfs_details" },
						detailRow("average", t.average, averageText),
						detailRow("realtime", realtimeLabel, formatTps(realtimeTps) + " " + t.unit)
					)
				);
				panel = createPortal === null ? body : createPortal(body, document.body);
			} catch (error) {
				reportOnce("panel", "details dialog failed, pill kept: " + describeError(error));
				panel = null;
			}
		}

		return React.createElement(
			"span",
			{ className: "dshpfs_root", "data-prefill-speed-stats": true, ref: rootRef },
			React.createElement("style", null, CSS),
			React.createElement(
				"button",
				{
					type: "button",
					className: "dshpfs_pill",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": t.title + " " + averageText,
					"data-prefill-speed-pill": true,
					onClick: function () {
						setOpen(!open);
					}
				},
				pencilIcon(),
				React.createElement("span", { className: "dshpfs_label" }, averageText)
			),
			panel
		);
	}

	/**
	 * Register the cell. The registration is guarded: a throw here fails the
	 * row's activation, and the boot audit treats a failed activation as a
	 * refused startup, which costs the user the whole application.
	 */
	function apply(ctx, config) {
		void config;
		try {
			ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: SLOT_ID, order: SLOT_ORDER }, PrefillSpeedStrip));
		} catch (error) {
			reportOnce("slot", "slot registration failed: " + describeError(error));
		}
	}

	const inject = ["slots"];

	exports.apply = apply;
	exports.inject = inject;
}
})();
