import React from "react";
import { Box, Button, Card, CardContent, Chip, Collapse, IconButton, LinearProgress, Typography } from "@mui/material";
import { ExpandMore, DoNotDisturbOn } from "@mui/icons-material";
import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from "@iobroker/types-vis-2";
import Generic from "./Generic";
import { PREVIEW_SVG } from "./previewIcon";

import { estimateProgress } from "./progress";
import { type OperationEntry, type SocketLike, formatDuration, parseOperations, watchDevice } from "./deviceData";

type DeviceCardRxData = {
	oid: string;
	compact: boolean;
	colorRunning: string;
	colorFinished: string;
	colorAlert: string;
};

type DeviceCardState = VisRxWidgetState & {
	deviceValues: Record<string, unknown>;
	expanded: boolean;
};

/** Card for one device: live values, estimated progress, acknowledge and do-not-disturb. */
export default class DeviceCard extends Generic<DeviceCardRxData, DeviceCardState> {
	private stopWatch: (() => void) | null = null;

	private watchedId = "";

	constructor(props: VisRxWidgetProps) {
		super(props);
		this.state = { ...this.state, deviceValues: {}, expanded: false };
	}

	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplDeviceReminderCard",
			visSet: "device-reminder",
			visName: "DeviceCard",
			visWidgetLabel: "device_card",
			visAttrs: [
				{
					name: "common",
					fields: [
						{ name: "oid", type: "id", label: "oid", filter: { type: "device" } },
						{ name: "compact", type: "checkbox", label: "compact", default: false },
						{ name: "colorRunning", type: "color", label: "color_running" },
						{ name: "colorFinished", type: "color", label: "color_finished" },
						{ name: "colorAlert", type: "color", label: "color_alert" },
					],
				},
			],
			visPrev: PREVIEW_SVG,
			visDefaultStyle: { width: 300, height: 200 },
		};
	}

	getWidgetInfo(): RxWidgetInfo {
		return DeviceCard.getWidgetInfo();
	}

	componentDidMount(): void {
		super.componentDidMount();
		this.updateWatch();
	}

	componentDidUpdate(): void {
		this.updateWatch();
	}

	componentWillUnmount(): void {
		this.stopWatch?.();
		this.stopWatch = null;
		super.componentWillUnmount();
	}

	private updateWatch(): void {
		const id = this.state.rxData.oid || "";
		if (id === this.watchedId) {
			return;
		}
		this.stopWatch?.();
		this.stopWatch = null;
		this.watchedId = id;
		this.setState({ deviceValues: {} });
		if (id) {
			const socket = this.props.context.socket as unknown as SocketLike;
			this.stopWatch = watchDevice(socket, id, values => this.setState({ deviceValues: values }));
		}
	}

	private async setValue(sub: string, val: boolean): Promise<void> {
		const socket = this.props.context.socket as unknown as SocketLike;
		await socket.setState(`${this.state.rxData.oid}.${sub}`, { val, ack: false });
	}

	private renderHistory(operations: OperationEntry[]): React.JSX.Element {
		if (!operations.length) {
			return <Typography variant="body2">{Generic.t("no_history")}</Typography>;
		}
		return (
			<Box
				component="table"
				sx={{ width: "100%", fontSize: "0.8rem" }}
			>
				<tbody>
					{[...operations].reverse().map((op, i) => (
						<tr key={`${op.start}-${i}`}>
							<td>{op.start}</td>
							<td>{op.runtime}</td>
						</tr>
					))}
				</tbody>
			</Box>
		);
	}

	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element | React.JSX.Element[] | null {
		super.renderWidgetBody(props);
		const { oid, compact, colorRunning, colorFinished, colorAlert } = this.state.rxData;
		if (!oid) {
			return (
				<Card style={{ width: "100%", height: "100%" }}>
					<CardContent>{Generic.t("select_device")}</CardContent>
				</Card>
			);
		}
		const v = this.state.deviceValues;
		const running = v.running === true;
		const finished = v.finished === true;
		const alert = v.alertRuntime === true;
		const dnd = v["config.doNotDisturb"] === true;
		const runtimeMs = typeof v.runtimeMs === "number" ? v.runtimeMs : 0;
		const operations = parseOperations(v.lastOperations);
		const progress = running ? estimateProgress(operations, runtimeMs) : { percent: null, remainingMs: null };
		const name = oid.split(".").pop() || oid;

		return (
			<Card style={{ width: "100%", height: "100%", overflow: "auto" }}>
				<CardContent>
					<Typography variant="h6">{name}</Typography>
					<Typography variant="body1">{String(v.status ?? "")}</Typography>
					<Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", my: 0.5 }}>
						{running && (
							<Chip
								size="small"
								label={Generic.t("running")}
								sx={{ bgcolor: colorRunning || undefined }}
							/>
						)}
						{finished && (
							<Chip
								size="small"
								label={Generic.t("finished")}
								sx={{ bgcolor: colorFinished || undefined }}
							/>
						)}
						{alert && (
							<Chip
								size="small"
								label={Generic.t("runtime_alert")}
								sx={{ bgcolor: colorAlert || "error.main" }}
							/>
						)}
					</Box>
					{!compact && (
						<Typography variant="body2">
							{typeof v.consumption === "number" ? `${v.consumption} W` : "-"} |{" "}
							{String(v.runtime ?? "0:00:00")}
						</Typography>
					)}
					{progress.percent !== null && (
						<Box sx={{ my: 0.5 }}>
							<LinearProgress
								variant="determinate"
								value={progress.percent}
							/>
							<Typography variant="caption">
								{progress.percent}% | {Generic.t("remaining")}{" "}
								{formatDuration(progress.remainingMs ?? 0)}
							</Typography>
						</Box>
					)}
					<Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 0.5 }}>
						<Button
							size="small"
							variant="contained"
							onClick={() => void this.setValue("acknowledge", true)}
						>
							{Generic.t("acknowledge")}
						</Button>
						<Button
							size="small"
							variant={dnd ? "contained" : "outlined"}
							startIcon={<DoNotDisturbOn />}
							onClick={() => void this.setValue("config.doNotDisturb", !dnd)}
						>
							{Generic.t("do_not_disturb")}
						</Button>
						{!compact && (
							<IconButton
								size="small"
								aria-label={Generic.t("history")}
								onClick={() => this.setState({ expanded: !this.state.expanded })}
							>
								<ExpandMore />
							</IconButton>
						)}
					</Box>
					<Collapse in={this.state.expanded && !compact}>{this.renderHistory(operations)}</Collapse>
				</CardContent>
			</Card>
		);
	}
}
