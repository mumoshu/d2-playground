import lightTheme from "../d2-vscode/themes/light-color-theme.json";
import * as monaco from "monaco-editor";
import { getLanguageProvider } from "../monaco/index.ts";

import Theme from "./theme.js";
import Layout from "./layout.js";
import Zoom from "./zoom.js";
import Alert from "./alert.js";

import QueryParams from "../lib/queryparams";

const MAX_ERRORS = 5;

let monacoEditor;
let monacoLineDecorators = [];

async function init() {
  if (useMonaco()) {
    await initMonaco();
  } else {
    initTextArea();
  }

  attachListeners();
  compile();
}

async function initMonaco() {
  const editorEl = document.getElementById("editor-main");
  const provider = await getLanguageProvider(lightTheme);

  monaco.editor.defineTheme("Light", {
    base: "vs",
    inherit: true,
    colors: lightTheme.colors,
    rules: [],
  });
  lightTheme.settings = lightTheme.tokenColors;

  monacoEditor = monaco.editor.create(editorEl, {
    language: "d2",
    automaticLayout: true,
    contextmenu: true,
    theme: lightTheme,
    tabSize: 2,
    autoIndent: "full",
    minimap: {
      enabled: false,
    },
    scrollbar: {
      useShadows: false,
      verticalScrollbarSize: 4,
      alwaysConsumeMouseWheel: false,
    },
    // TODO add some warning if a 4 figure number of lines is input
    lineNumbersMinChars: 3,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: "none",
    overviewRulerBorder: false,
    wordWrap: "on",
    wrappingIndent: "same",
    padding: {
      // padding to offset the focus border
      top: 4,
      bottom: 4,
    },
  });
  // No cmd+L highjacking
  monacoEditor._standaloneKeybindingService.addDynamicKeybinding(
    "-expandLineSelection",
    undefined,
    () => undefined
  );
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, compile);
  provider.registry.setTheme(lightTheme);
  monaco.editor.setTheme(lightTheme);

  let initialScript = "x -> y";
  const paramScript = QueryParams.get("script");
  if (paramScript) {
    const decodedResult = JSON.parse(d2Decode(paramScript));
    if (decodedResult.result !== "") {
      initialScript = decodedResult.result;
    } else {
      QueryParams.del("script");
    }
  }

  monacoEditor.setValue(initialScript);
  monacoEditor.focus();
  provider.injectCSS();
}

function initTextArea() {
  const editorEl = document.getElementById("editor-main");
  editorEl.innerHTML = "<textarea id='mobile-editor'>x -> y</textarea>";
}

async function attachListeners() {
  document.getElementById("compile-btn").addEventListener("click", compile);
}

function displayCompileErrors(errs) {
  if (monacoEditor) {
    const model = monacoEditor.getModel();

    // Make the errored line numbers red in the side bar
    monacoLineDecorators = monacoEditor.deltaDecorations(
      monacoLineDecorators,
      errs.map((err) => {
        const range = parseRange(err.range);
        return {
          range: new monaco.Range(
            range.start.line,
            range.start.column,
            range.end.line,
            range.end.column
          ),
          options: {
            marginClassName: "ErrorLineGutter"
          },
        };
      })
    );

    // Underline the errored syntax
    monaco.editor.setModelMarkers(
      model,
      "parser",
      errs.map((err) => {
        const range = parseRange(err.range);
        return {
          startLineNumber: range.start.line,
          endLineNumber: range.end.line,
          startColumn: range.start.column,
          endColumn: range.end.column,
          message: err.errmsg,
          severity: monaco.MarkerSeverity.Error,
        };
      })
    );
  }

  // Show the error messages
  if (errs.length > MAX_ERRORS) {
    errs = [
      ...errs.slice(0, MAX_ERRORS),
      {
        errmsg: `... and ${errs.length - MAX_ERRORS} more error(s)`,
      },
    ];
  }
  let errContent = '';
  for (const err of errs) {
    errContent += `<div class="editor-errors-line">${err.errmsg}</div>`;
  }
  const displayEl = document.getElementById("editor-errors");
  displayEl.innerHTML = errContent;
  displayEl.style.display = 'block';
}

function clearCompileErrors() {
  if (monacoEditor) {
    const model = monacoEditor.getModel();
    monacoEditor.deltaDecorations(monacoLineDecorators, []);
    monaco.editor.setModelMarkers(model, "parser", []);
  }

  const displayEl = document.getElementById("editor-errors");
  displayEl.innerHTML = '';
  displayEl.style.display = 'none';
}

async function compile() {
  if (document.getElementById("compile-btn").classList.contains("btn-disabled")) {
    return;
  }

  lockCompileBtn();
  let script = getScript();
  if (!script.endsWith("\n")) {
    script += "\n";
  }

  const encodeResult = JSON.parse(d2Encode(script));
  if (encodeResult.result == "") {
    Alert.show(`D2 encountered an encoding error. Please help improve D2 by sharing this link on&nbsp;<a href="https://github.com/terrastruct/d2/issues/new">Github</a>.`, 6000);
    return;
  }
  const encoded = encodeResult.result;

  // set even if compilation or layout later fails. User may want to share debug session
  QueryParams.set("script", encoded);

  const compiled = d2Compile(script);
  if (compiled) {
    let parsed = JSON.parse(compiled);
    if (parsed.result != "") {
      script = parsed.result;
      setScript(script);
    } else if (parsed.userError != "") {
      parsed = JSON.parse(parsed.userError);
      displayCompileErrors(parsed.errs);
      unlockCompileBtn();
      return;
    } else if (parsed.d2Error != "") {
      unlockCompileBtn();
      Alert.show(`D2 encountered a compile error. Please help improve D2 by sharing this link on&nbsp;<a href="https://github.com/terrastruct/d2/issues/new">Github</a>.`, 6000);
      return;
    }
  }
  clearCompileErrors();

  showLoader();

  const talaKey = Layout.getTALAKey();
  const layout = Layout.getLayout();

  const headers = {};
  if (layout == "tala" && talaKey) {
    headers['x-tala-key'] = talaKey;
  }

  let response;
  try {
    response = await fetch(`https://api.d2lang.com/render/svg?script=${encoded}&layout=${layout}&theme=${Theme.getThemeID()}`, {
      headers,
      method: 'GET'
    });
  } catch(e) {
    // 4-500s do not throw
    Alert.show(`Unexpected error occurred. Please make sure you are connected to the internet.`, 6000);
    hideLoader();
    unlockCompileBtn();
    return;
  }
  hideLoader();
  unlockCompileBtn();
  if (response.status === 500) {
    Alert.show(`D2 encountered an API error. Please help improve D2 by sharing this link on&nbsp;<a href="https://github.com/terrastruct/d2/issues/new">Github</a>.`, 6000);
    return;
  }
  if (response.status === 403) {
    Alert.show(`You're doing that a bit too much. Please reach out to us at hi@d2lang.com if you're a human.`, 6000);
    return;
  }
  if (!response.ok) {
    Alert.show(`D2 encountered an unexpected error. Please help improve D2 by sharing this link on&nbsp;<a href="https://github.com/terrastruct/d2/issues/new">Github</a>.`, 6000);
    return;
  }
  const svg = await response.text();
  const renderEl = document.getElementById("render-svg");
  const containerWidth = renderEl.getBoundingClientRect().width;
  const containerHeight = renderEl.getBoundingClientRect().height;
  renderEl.innerHTML = svg;
  const svgEl = renderEl.firstChild.nextSibling.nextSibling;

  svgEl.id = "diagram";
  Zoom.attach();

  svgEl.setAttribute("width", `${containerWidth}px`);
  svgEl.setAttribute("height", `${containerHeight}px`);
  unlockCompileBtn();
}

function parseRange(rs) {
  const i = rs.lastIndexOf("-");
  if (i === -1) {
    throw new Error(`missing end field in range ${rs}`);
  }
  const end = rs.substring(i + 1);

  const j = rs.lastIndexOf(",", i);
  if (j === -1) {
    throw new Error(`missing start field in range ${rs}`);
  }
  const start = rs.substring(j + 1, i);
  const path = rs.substring(0, j);

  return {
    path: path,
    start: parsePosition(start),
    end: parsePosition(end),
  };
}

function parsePosition(ps) {
  const fields = ps.split(":");
  if (fields.length !== 3) {
    throw new Error(`expected three fields in position ${ps}`);
  }
  return {
    line: Number(fields[0]) + 1,
    column: Number(fields[1]) + 1,
    byte: Number(fields[2]),
  };
}

function showLoader() {
  document.getElementById("loading-shroud").style.display = "flex";
}
function hideLoader() {
  document.getElementById("loading-shroud").style.display = "none";
}

function lockCompileBtn() {
  document.getElementById("compile-btn").classList.add("btn-disabled");
}

function unlockCompileBtn() {
  document.getElementById("compile-btn").classList.remove("btn-disabled");
}

function getScript() {
  if (monacoEditor) {
    return getEditor().getValue();
  }
  return document.getElementById("mobile-editor").value;
}

function setScript(script) {
  if (monacoEditor) {
    getEditor().setValue(script);
  } else {
    document.getElementById("mobile-editor").value = script;
  }
}

function getEditor() {
  return monacoEditor;
}

// NOTE monaco editor is purported to not work on mobile
// https://github.com/microsoft/monaco-editor/issues/246
// But I've tested it on all my devices and it works.
// The code is set up to replace monaco with textarea already, so if users report monaco giving them problems,
// only enable when not mobile
function useMonaco() {
  return true;
}

export default {
  init,
  displayCompileErrors,
  clearCompileErrors,
  getEditor,
  compile,
}
