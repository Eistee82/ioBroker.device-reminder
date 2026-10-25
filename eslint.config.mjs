import config from "@iobroker/eslint-config";
import mochaPlugin from "eslint-plugin-mocha";
export default [
	...config,
	{ ignores: ["build/", "admin/", "widgets/", "src-widgets/", "*.config.mjs", "test/fixtures/", "tasks.ts"] },
	{
		files: ["test/**/*.js"],
		plugins: { mocha: mochaPlugin },
		languageOptions: {
			globals: {
				describe: "readonly",
				it: "readonly",
				before: "readonly",
				after: "readonly",
				beforeEach: "readonly",
				afterEach: "readonly",
			},
		},
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"mocha/no-exclusive-tests": "error",
		},
	},
	// Browser globals for the Blockly block definitions (admin/blockly.js, Task 15). admin/ is ignored
	// above; the globals block applies if linting of admin/blockly.js is enabled later.
	{
		files: ["admin/blockly.js"],
		languageOptions: {
			globals: {
				Blockly: "readonly",
				javascript: "readonly",
				window: "readonly",
				document: "readonly",
				systemLang: "readonly",
				main: "readonly",
				$: "readonly",
				jQuery: "readonly",
				getObject: "readonly",
				fetch: "readonly",
			},
		},
	},
];
