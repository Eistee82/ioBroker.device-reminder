"use strict";
/*
 * Test oracle for the start/end detection of iobroker.device-reminder 3.1.2.
 *
 * Origin: iobroker.device-reminder@3.1.2 (npm), main.js lines 376-397 (derived values),
 * 638-804 (evaluatingInputValue, evaluateStatus) and 861-895 (calcStart, calculation).
 * Ported 1:1 without ioBroker: every state write, status change, message, autoOff and runtime call
 * is recorded in a protocol instead of being executed. async/await was dropped because nothing
 * in these functions performs I/O once the adapter calls are replaced by the protocol.
 * Only the order of operations matters for parity and it is unchanged.
 *
 * Original code: Copyright (c) 2020-2024 xenon-s, MIT License
 * (https://github.com/xenon-s/ioBroker.device-reminder/blob/master/LICENSE)
 */

const STATUS = { start: "running", standby: "standby", end: "off" };

/**
 * @param {{startVal:number,endVal:number,standby:number,startCount:number,endCount:number}} objVal type thresholds
 * @param {{abort:boolean, autoOff?:boolean}} options device options
 */
function createOracle(objVal, options) {
	// main.js 368-416 (constructor of the device object), only the fields used by the detection
	const device = {
		started: false,
		abort: options.abort,
		autoOff: !!options.autoOff,
		startValue: objVal.startVal,
		endValue: objVal.endVal,
		standbyValue: objVal.standby != "" ? objVal.standby || 1 : 1,
		startCount: objVal.startCount,
		endCount: objVal.endCount,
		standbyCount: objVal.endVal <= 10 ? objVal.endVal || 10 : 10,
		timeouts: { autoOff: null },
		startTime: 0,
		endTime: 0,
		valCancel: objVal.endCount / 2,
		message: { startMessage: true, endMessage: true, startMessageSent: false, endMessageSent: false },
		arrays: { start: [], end: [], standby: [], dateJSON: [] },
		calculation: { consumption: 0, start: 0, end: 0, standby: 0, alertCounter: 0 },
	};

	let consumption = 0;
	/** @type {Array<[string, unknown]>} */
	let protocol = [];

	const log = (kind, value) => protocol.push([kind, value]);
	const setStatus = status => log("status", status);
	const autoOff = () => {
		if (device.autoOff) {
			if (device.timeouts.autoOff == null) {
				device.timeouts.autoOff = "armed";
				log("autoOff", "armed");
			}
		}
	};
	const runtime = () => log("runtime", null);

	// main.js 881-895
	function calculation(arr) {
		let numb = 0;
		let resultTemp = 0;
		for (const i in arr) {
			numb = parseFloat(arr[i]);
			resultTemp = resultTemp + numb;
		}
		return Math.round((resultTemp / arr.length) * 100) / 100;
	}

	// main.js 861-879
	function calcStart(type) {
		const value = consumption;
		const count = `${type}Count`;
		const calcType = type;

		device.arrays[calcType].push(value);
		device.calculation[calcType] = calculation(device.arrays[calcType]);
		log("averageConsumption", device.calculation[calcType]);

		if (device.arrays[calcType].length > device[count]) {
			device.arrays[calcType].shift();
		}
	}

	// main.js 638-674
	function evaluatingInputValue() {
		switch (device.started) {
			case true: {
				calcStart("standby");
				calcStart("end");
				device.arrays.start = [];
				break;
			}
			case false: {
				if (consumption < device.startValue) {
					device.arrays.start = [];
					calcStart("standby");
				} else {
					calcStart("start");
					device.arrays.standby = [];
				}
				break;
			}
			default:
				break;
		}
		return true;
	}

	// main.js 680-804
	function evaluateStatus() {
		if (device.abort) {
			if (device.started) {
				if (
					device.calculation.standby < device.standbyValue &&
					device.arrays.standby.length >= device.valCancel
				) {
					log("event", "aborted");
					setStatus("end");
					log("averageConsumption", device.calculation.standby);
					if (device.autoOff) {
						autoOff();
					}

					device.started = false;
					device.message.endMessageSent = false;
					device.message.startMessageSent = false;

					device.arrays.start = [];
					device.arrays.end = [];
					device.arrays.standby = [];
				}
			}
		}

		if (
			device.calculation.start > device.startValue &&
			device.calculation.start != null &&
			device.arrays.start.length >= device.startCount &&
			!device.started
		) {
			log("event", "started");
			device.started = true;
			device.startTime = Date.now();
			runtime();
			setStatus("start");

			if (device.message.startMessage && !device.message.startMessageSent) {
				log("message", "start");
			}

			device.message.startMessageSent = true;
			device.message.endMessageSent = false;
		}

		if (device.calculation.end > device.endValue && device.calculation.end != null && device.started) {
			log("event", "running");
			if (device.timeouts.autoOff != null) {
				device.timeouts.autoOff = null;
				log("autoOff", "cleared");
			}
			setStatus("start");
			runtime();
		} else if (
			device.calculation.end < device.endValue &&
			device.calculation.end != null &&
			device.started &&
			device.arrays.end.length >= device.endCount * (2 / 3)
		) {
			log("event", "finished");
			if (
				device.started &&
				device.message.endMessage &&
				!device.message.endMessageSent &&
				device.message.startMessageSent
			) {
				device.message.startMessageSent = false;
				device.message.endMessageSent = true;
				log("message", "end");
			}

			device.started = false;
			log("lastOperations", null);
			log("lastRuntime", null);
			log("alertRuntime", false);

			if (device.calculation.end < device.standbyValue) {
				device.calculation.standby = device.calculation.end;
				device.arrays.standby = [];
				setStatus("end");
			} else {
				setStatus("standby");
			}

			autoOff();

			device.endTime = Date.now();
			device.arrays.start = [];
			device.arrays.end = [];
		}

		if (!device.started) {
			if (device.calculation.standby >= device.standbyValue && device.calculation.standby < device.endValue) {
				setStatus("standby");
			} else if (device.calculation.standby <= device.standbyValue) {
				setStatus("end");
			}
		}

		log("liveConsumption", consumption);
	}

	return {
		device,
		/** @returns {Array<[string, unknown]>} protocol of the last tick */
		get protocol() {
			return protocol;
		},
		/**
		 * One poll tick (main.js 629-633: getValues).
		 *
		 * @param {number} power last known power value
		 */
		tick(power) {
			protocol = [];
			consumption = power;
			evaluatingInputValue();
			evaluateStatus();

			const events = protocol.filter(([k]) => k === "event").map(([, v]) => v);
			const statuses = protocol.filter(([k]) => k === "status").map(([, v]) => STATUS[v]);
			const averages = protocol.filter(([k]) => k === "averageConsumption").map(([, v]) => v);
			return {
				events,
				status: statuses.length ? statuses[statuses.length - 1] : null,
				average: averages.length ? averages[averages.length - 1] : null,
				started: device.started,
			};
		},
	};
}

module.exports = { createOracle };
