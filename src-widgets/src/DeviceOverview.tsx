import React from "react";
import { Box, Card, CardContent, Chip, List, ListItemButton, ListItemText, Typography } from "@mui/material";
import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetProps, VisRxWidgetState } from "@iobroker/types-vis-2";
import Generic from "./Generic";
import { type SocketLike, watchDevice } from "./deviceData";

type DeviceOverviewRxData = {
	instance: string;
};

type DeviceOverviewState = VisRxWidgetState & {
	devices: string[];
	rows: Record<string, Record<string, unknown>>;
};

interface OverviewSocket extends SocketLike {
	getObjectViewSystem(
		type: string,
		start: string,
		end: string,
	): Promise<Record<string, { _id: string; common?: { name?: unknown } }>>;
}

/** Compact list of all devices of one adapter instance. */
export default class DeviceOverview extends Generic<DeviceOverviewRxData, DeviceOverviewState> {
	private stops: (() => void)[] = [];

	private loadedInstance = "";

	private disposed = false;

	constructor(props: VisRxWidgetProps) {
		super(props);
		this.state = { ...this.state, devices: [], rows: {} };
	}

	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplDeviceReminderOverview",
			visSet: "device-reminder",
			visName: "DeviceOverview",
			visWidgetLabel: "device_overview",
			visAttrs: [
				{
					name: "common",
					fields: [
						{
							name: "instance",
							type: "instance",
							label: "instance",
							adapter: "device-reminder",
							default: "device-reminder.0",
						},
					],
				},
			],
			visDefaultStyle: { width: 320, height: 300 },
		};
	}

	getWidgetInfo(): RxWidgetInfo {
		return DeviceOverview.getWidgetInfo();
	}

	componentDidMount(): void {
		super.componentDidMount();
		void this.load();
	}

	componentDidUpdate(): void {
		void this.load();
	}

	componentWillUnmount(): void {
		this.disposed = true;
		this.stopAll();
		super.componentWillUnmount();
	}

	private stopAll(): void {
		this.stops.forEach(stop => stop());
		this.stops = [];
	}

	private async load(): Promise<void> {
		const namespace = this.state.rxData.instance || "device-reminder.0";
		if (namespace === this.loadedInstance) {
			return;
		}
		this.loadedInstance = namespace;
		this.stopAll();
		const socket = this.props.context.socket as unknown as OverviewSocket;
		let objects: Awaited<ReturnType<OverviewSocket["getObjectViewSystem"]>> = {};
		try {
			objects = await socket.getObjectViewSystem("device", `${namespace}.`, `${namespace}.香`);
		} catch {
			objects = {};
		}
		if (this.disposed || namespace !== this.loadedInstance) {
			return;
		}
		const devices = Object.keys(objects)
			.filter(id => id.split(".").length === 3)
			.sort();
		this.setState({ devices, rows: {} });
		this.stops = devices.map(id =>
			watchDevice(socket, id, values => this.setState(prev => ({ rows: { ...prev.rows, [id]: values } }))),
		);
	}

	private async acknowledge(id: string): Promise<void> {
		const socket = this.props.context.socket as unknown as SocketLike;
		await socket.setState(`${id}.acknowledge`, { val: true, ack: false });
	}

	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element | React.JSX.Element[] | null {
		super.renderWidgetBody(props);
		const { devices, rows } = this.state;
		return (
			<Card style={{ width: "100%", height: "100%", overflow: "auto" }}>
				<CardContent>
					{!devices.length && <Typography variant="body2">{Generic.t("no_devices")}</Typography>}
					<List dense>
						{devices.map(id => {
							const v = rows[id] ?? {};
							const consumption = typeof v.consumption === "number" ? `${v.consumption} W` : "-";
							return (
								<ListItemButton
									key={id}
									onClick={() => void this.acknowledge(id)}
									title={Generic.t("acknowledge")}
								>
									<ListItemText
										primary={id.split(".").pop()}
										secondary={`${String(v.status ?? "")} | ${consumption} | ${String(v.runtime ?? "0:00:00")}`}
									/>
									<Box>
										{v.finished === true && (
											<Chip
												size="small"
												color="success"
												label={Generic.t("finished")}
											/>
										)}
									</Box>
								</ListItemButton>
							);
						})}
					</List>
				</CardContent>
			</Card>
		);
	}
}
