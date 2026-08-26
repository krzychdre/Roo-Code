// npx vitest run src/__tests__/index.test.ts

import { generatePackageJson } from "../index.js"

describe("generatePackageJson", () => {
	it("rewrites command/view/config IDs for the nightly variant", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "tumble-code",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "QUB-IT",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "tumble-code-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"tumble-code-ActivityBar": [
							{
								type: "webview",
								id: "tumble-code.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "tumble-code.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "tumble-code.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "tumble-code.contextMenu",
								group: "navigation",
							},
						],
						"tumble-code.contextMenu": [
							{
								command: "tumble-code.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "tumble-code.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == tumble-code.TabPanelProvider",
							},
							{
								command: "tumble-code.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == tumble-code.TabPanelProvider",
							},
							{
								command: "tumble-code.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == tumble-code.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "tumble-code.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "tumble-code.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"tumble-code.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"tumble-code.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
							"tumble-code.apiRequestTimeout": {
								type: "integer",
								default: 600,
								minimum: 1,
								maximum: 3600,
								description: "%settings.apiRequestTimeout.description%",
							},
							"tumble-code.cloudApiUrl": {
								type: "string",
								default: "",
								description: "%settings.cloudApiUrl.description%",
								markdownDescription: "%settings.cloudApiUrl.description%",
								order: 100,
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "tumble-code-nightly",
				displayName: "Tumble Code Nightly",
				publisher: "QUB-IT",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["tumble-code", "tumble-code-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "tumble-code-nightly",
			displayName: "Tumble Code Nightly",
			description: "%extension.description%",
			publisher: "QUB-IT",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "tumble-code-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"tumble-code-nightly-ActivityBar": [
						{
							type: "webview",
							id: "tumble-code-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "tumble-code-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "tumble-code-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "tumble-code-nightly.contextMenu",
							group: "navigation",
						},
					],
					"tumble-code-nightly.contextMenu": [
						{
							command: "tumble-code-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "tumble-code-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == tumble-code-nightly.TabPanelProvider",
						},
						{
							command: "tumble-code-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == tumble-code-nightly.TabPanelProvider",
						},
						{
							command: "tumble-code-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == tumble-code-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "tumble-code-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "tumble-code-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"tumble-code-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"tumble-code-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
						"tumble-code-nightly.apiRequestTimeout": {
							type: "integer",
							default: 600,
							minimum: 1,
							maximum: 3600,
							description: "%settings.apiRequestTimeout.description%",
						},
						"tumble-code-nightly.cloudApiUrl": {
							type: "string",
							default: "",
							description: "%settings.cloudApiUrl.description%",
							markdownDescription: "%settings.cloudApiUrl.description%",
							order: 100,
						},
					},
				},
			},
			scripts: {},
		})
	})
})
