// Same rules as the Obsidian community directory review: run `npm run lint`.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build output, Node build scripts and the test harness are not plugin code.
	globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "version-bump.mjs", "test"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
			},
		},
	},
]);
