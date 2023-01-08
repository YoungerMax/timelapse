import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { existsSync, unlinkSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

let recordingProcess: childProcess.ChildProcess;
let statusBarIcon: vscode.StatusBarItem;
let currentRecordingFile: string | undefined;
let updateRecordingTimeInterval: NodeJS.Timer | undefined;
let startedRecordingTimestamp: number | undefined;
let isFfmpegInstalled: boolean = true;

const fallbackSaveDir = path.resolve('vscode-timelapses');
const fallbackSourceFps = 1;
const fallbackFinalFps = 60;

const openTimelapseAction = 'Open';
const openAndCopyAction = 'Open & copy';
const copyToClipboardAction = 'Copy to clipboard';
const openInBrowserAction = 'Visit website in browser';

const startRecordingCommand = 'timelapse.startRecording';
const stopRecordingCommand = 'timelapse.stopRecording';

enum RecordingState {
	NOT_RECORDING,
	STARTING,
	RECORDING,
	STOPPING,
	FINALIZING
}

export function activate(context: vscode.ExtensionContext) {
	checkFfmpegInstalled();

	let startRecordingDisposable = vscode.commands.registerCommand(startRecordingCommand, startRecording);
	let stopRecordingDisposable = vscode.commands.registerCommand(stopRecordingCommand, stopRecording);

	context.subscriptions.push(startRecordingDisposable);
	context.subscriptions.push(stopRecordingDisposable);

	statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	updateRecordingState(RecordingState.NOT_RECORDING);
	statusBarIcon.show();
}

export function startRecording() {
	if (!isFfmpegInstalled) {
		showFfmpegIsNotInstalled();
		return;
	}

	updateRecordingState(RecordingState.STARTING);
	currentRecordingFile = getTemporaryRecordingFile();

	let inputFormat;

	switch (process.platform) {
		case 'win32':
			inputFormat = 'gdigrab';
			break;

		case 'darwin':
			inputFormat = 'avfoundation';
			break;
	
		case 'linux':
			inputFormat = 'x11grab';
			break;

		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}

	recordingProcess = childProcess.exec(`ffmpeg -f ${inputFormat} -framerate ${getSourceFps()} -i :0.0 ${currentRecordingFile}`);
	recordingProcess.once('spawn', () => {
		updateRecordingState(RecordingState.RECORDING);
	});
}

export function updateRecordingState(state: RecordingState) {
	switch (state) {
		case RecordingState.NOT_RECORDING:
			statusBarIcon.text = '$(record) Record';
			statusBarIcon.command = startRecordingCommand;
			statusBarIcon.backgroundColor = undefined;
			statusBarIcon.tooltip = 'Start recording a timelapse';

			if (updateRecordingTimeInterval !== undefined) {
				clearInterval(updateRecordingTimeInterval);
				updateRecordingTimeInterval = undefined;
			}
			
			break;
		
		case RecordingState.STOPPING:
		case RecordingState.FINALIZING:
		case RecordingState.STARTING:
			statusBarIcon.text = '$(loading~spin)';
			statusBarIcon.command = undefined;
			statusBarIcon.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			statusBarIcon.tooltip = 'Please wait';

			if (updateRecordingTimeInterval !== undefined) {
				clearInterval(updateRecordingTimeInterval);
				updateRecordingTimeInterval = undefined;
			}

			break;

		case RecordingState.RECORDING:
			startedRecordingTimestamp = Date.now();

			statusBarIcon.text = '$(record) Stop';
			statusBarIcon.command = stopRecordingCommand;
			statusBarIcon.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			
			updateRecordingTimeInterval = setInterval(updateRecordingTime, 1000);
			break;
	}
}

export function stopRecording() {
	if (!isFfmpegInstalled) {
		showFfmpegIsNotInstalled();
		return;
	}

	updateRecordingState(RecordingState.STOPPING);

	recordingProcess.kill();
	recordingProcess.once('exit', () => {
		vscode.window.showSaveDialog({
			saveLabel: 'Save',
			title: 'Timelapse output file'
		}).then(uri => {
			let savePath = uri?.fsPath === undefined ? getNewSaveFile() : path.resolve(uri?.fsPath);

			if (stopRecordingAndSave(savePath)) {
				vscode.window.showInformationMessage(`Saved timelapse: ${savePath}`, openTimelapseAction, openAndCopyAction, copyToClipboardAction).then(action => {
					switch (action) {
						case openTimelapseAction:
							openVideoPlayer(savePath);
							break;

						case openAndCopyAction:
							vscode.env.clipboard.writeText(savePath);
							vscode.window.showInformationMessage('Copied timelapse path to clipboard');

							openVideoPlayer(savePath);
							break;

						case copyToClipboardAction:
							vscode.env.clipboard.writeText(savePath);
							vscode.window.showInformationMessage('Copied timelapse path to clipboard');
							break;
					}
				});
			} else {
				vscode.window.showErrorMessage(`Could not save timelapse!`);
			}

			updateRecordingState(RecordingState.NOT_RECORDING);
		});
	});
}

function stopRecordingAndSave(savePath: string): boolean {
	if (currentRecordingFile === undefined) {
		throw new Error('Tried to stop recording when not currently recording');
	}

	updateRecordingState(RecordingState.FINALIZING);
	deleteFile(savePath);
	
	try {
		childProcess.execSync(`ffmpeg -itsscale ${1 / getFinalFps()} -i ${currentRecordingFile} -c copy ${savePath}`);

		deleteFile(currentRecordingFile);

		return true;
	} catch (err) {
		return false;
	}
}

export function openVideoPlayer(videoPath: string) {
	const videoUri = vscode.Uri.file(videoPath);
	const panel = vscode.window.createWebviewPanel('timelapseVideo', 'Timelapse video', vscode.ViewColumn.Active, {
		localResourceRoots: [vscode.Uri.parse(path.dirname(videoPath))],
		enableScripts: false,
		enableForms: false
	});

	const webviewUri = panel.webview.asWebviewUri(videoUri);

	panel.webview.html = `<!DOCTYPE html><html><head><style>body { display: flex; align-items: center; justify-content: center; height: 100vh; }</style></head><body><video controls><source src="${webviewUri}"></video></body></html>`;
}

function deleteFile(path: string) {
	if (existsSync(path)) unlinkSync(path);
}

function createDirectories(path: string) {
	if (!existsSync(path)) fs.mkdirSync(path, { recursive: true });
}

function getNextName(parentDir: string, fileName: string, fileExtension: string): string {
	let i = 0;
	let savePath: string | undefined;

	const chooseNextName = () => {
		i++;

		let randomPart: string;
		let hash = crypto.createHash('sha256');

		hash.update(crypto.randomBytes(1024));
		randomPart = hash.digest('hex') + crypto.randomBytes(128).readUInt32LE().toString();
		savePath = path.join(parentDir, `${fileName}-${randomPart}${fileExtension}`);
	};

	for (; savePath === undefined || (savePath !== undefined && existsSync(savePath)); chooseNextName());

	return savePath;
}

function getTemporaryRecordingFile(): string {
	return getNextName(os.tmpdir(), 'timelapse-temp', '.mp4');
}

function getNewSaveFile(): string {
	let saveDir: string | undefined = vscode.workspace.getConfiguration('timelapse').get('saveDirectory');
	let saveDirPath = path.resolve(saveDir === undefined ? fallbackSaveDir : saveDir);
	createDirectories(saveDirPath);

	return getNextName(saveDirPath, 'timelapse-save', '.mp4');
}

function getSourceFps(): number {
	let sourceFps: string | undefined = vscode.workspace.getConfiguration('timelapse').get('sourceFps');

	return sourceFps === undefined ? fallbackSourceFps : parseInt(sourceFps);
}

function getFinalFps(): number {
	let finalFps: string | undefined = vscode.workspace.getConfiguration('timelapse').get('finalFps');

	return finalFps === undefined ? fallbackFinalFps : parseInt(finalFps);
}

function updateRecordingTime() {
	if (startedRecordingTimestamp === undefined) {
		throw new Error('Not currently recording, but trying to update time');
	}

	const elapsedTime = Date.now() - startedRecordingTimestamp;
	let seconds = elapsedTime / 1000;
	let minutes = seconds / 60;
	let hours = minutes / 60;

	seconds = Math.floor(seconds) % 60;
	minutes = Math.floor(minutes) % 60;
	hours = Math.floor(hours);

	statusBarIcon.tooltip = `${hours > 9 ? hours : '0' + hours}:${minutes > 9 ? minutes : '0' + minutes}:${seconds > 9 ? seconds : '0' + seconds}`;
}

function showFfmpegIsNotInstalled() {
	vscode.window.showErrorMessage('ffmpeg is not installed! Timelapse requires ffmpeg to record your screen and speed up the video.', openInBrowserAction).then(action => {
		// This switch statement is necessary because other actions are fired too
		switch (action) {
			case openInBrowserAction:
				openLinkInBrowser(new URL('https://ffmpeg.org/download.html'));
				break;
		}
	});
}

function checkFfmpegInstalled() {
	const disable = () => {
		isFfmpegInstalled = false;
		showFfmpegIsNotInstalled();
		deactivate();
	};

	try {
		childProcess.exec('ffmpeg', (err, stdout, stderr) => {
			if (err !== null && err.code !== 1) disable();
		});
	} catch (err) {
		vscode.window.showWarningMessage('Could not check if ffmpeg is installed. Features of Timelapse may not work!');
	}
}

function openLinkInBrowser(link: URL) {
	let openCommand;

	switch (process.platform) {
		case 'win32':
			openCommand = `explorer ${link.toString()}`;
			break;

		case 'darwin':
			openCommand = `open ${link.toString()}`;
			break;

		case 'linux':
			openCommand = `xdg-open ${link.toString()}`;
			break;

		default:
			throw new Error(`Operating system is not supported: ${process.platform}`);
	}

	childProcess.exec(openCommand);
}

export function deactivate() {
	if (recordingProcess !== undefined) {
		stopRecordingAndSave(getNewSaveFile());
	}

	statusBarIcon.dispose();
}
