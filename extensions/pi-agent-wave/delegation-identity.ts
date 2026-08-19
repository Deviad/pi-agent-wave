import { truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_ID = "delegation-identity";
const POWERBAR_SEGMENT_ID = "delegation-identity";

function labelFromEnv(): string | undefined {
	const label = process.env.PI_DELEGATION_LABEL?.trim();
	const kind = process.env.PI_DELEGATION_KIND?.trim();
	if (!label && !kind) return undefined;
	if (kind && label) return `${kind}: ${label}`;
	return label || kind;
}

function emitPowerbar(pi: any, label?: string): void {
	try {
		pi.events.emit("powerbar:register-segment", { id: POWERBAR_SEGMENT_ID, label: "Delegation Identity" });
		pi.events.emit("powerbar:update", label
			? { id: POWERBAR_SEGMENT_ID, text: label, icon: "⇢", color: "warning" }
			: { id: POWERBAR_SEGMENT_ID, text: undefined });
	} catch {
		/* Powerbar is optional. */
	}
}

function setWidget(ctx: any, label?: string): void {
	try {
		if (!ctx?.hasUI || !ctx.ui?.setWidget) return;
		if (!label) {
			ctx.ui.setWidget(WIDGET_ID, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui: any, theme: any) => ({
				render(width: number): string[] {
					const text = truncateToWidth(`⇢ delegated ${label}`, Math.max(1, width));
					return [theme?.fg ? theme.fg("warning", text) : text];
				},
				invalidate(): void {},
			}),
			{ placement: "belowEditor" },
		);
	} catch {
		/* UI updates must not affect the agent. */
	}
}

export default function delegationIdentityExtension(pi: any): void {
	const label = labelFromEnv();
	emitPowerbar(pi, label);
	pi.on?.("session_start", async (_event: any, ctx: any) => {
		emitPowerbar(pi, label);
		setWidget(ctx, label);
	});
	pi.on?.("session_shutdown", async (_event: any, ctx: any) => {
		setWidget(ctx);
		emitPowerbar(pi);
	});
}
