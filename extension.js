// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');
const https = require('https');
const mdpdf = require('./markdownPdf.js');

// axiosで証明書エラー避け
https.globalAgent.options.rejectUnauthorized = false;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    const commands = [
        vscode.commands.registerCommand('extension.md2singlehtml.convertSingleHtml', async function () { await convertSingleHtml(); }),
        vscode.commands.registerCommand('extension.md2singlehtml.convertAll', async function () { await convertAll(); }),
    ];
    commands.forEach(function (command) {
        context.subscriptions.push(command);
    });
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() { }
exports.deactivate = deactivate;

async function convertSingleHtml() {

    try {
        // check active window
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Markdown to SingleHtml : No active Editor!');
            return;
        }

        // check markdown mode
        const mode = editor.document.languageId;
        if (mode != 'markdown') {
            vscode.window.showWarningMessage('Markdown to SingleHtml : It is not a markdown mode!');
            return;
        }
        vscode.window.setStatusBarMessage('');

        // Markdown-PDFでHTMLに変換する
        vscode.window.showInformationMessage('');           // ←何故かこれを入れないとリリースモードでエラーになってしまう（Error: ENOENT: no such file or directory, open {ファイル名}）
        await mdpdf.convertToHtml(editor.document.uri);
        // プレーンなHTMLをSingleHTMLにする
        vscode.window.showInformationMessage('');
        await editHtml(editor.document.uri);

    } catch (error) {
        showErrorMessage('Markdown to SingleHtml()', error);
    }
}

async function editHtml(docUri) {

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '[Markdown to SingleHtml]: Converting ...'

    }, async () => {
        const statusbarMessageTimeout = 10000;

        // 直下にできたHMTLを読み込む
        const mdfilename = docUri.fsPath;
        vscode.window.setStatusBarMessage('$(markdown) ' + path.extname(mdfilename), statusbarMessageTimeout);
        const htmlfilename = mdfilename.replace(path.extname(mdfilename), '.html');
        // if (!isExistsPath(htmlfilename)) {
        //     vscode.window.showWarningMessage('Markdown to SingleHtml : File does not get!');
        //     return;
        // }
        // 非同期でMarkdown-PDFを実行させても、直後のファイル読み込みではサイズが0となってしまう
        // しかたないので読み込めるまでループさせる・・・
        let html = '';
        let cnt = 0;
        while (html.length === 0) {
            html = fs.readFileSync(htmlfilename, 'utf8');
            cnt++;
            if (cnt > 7) {
                // ダメならあきらめ
                vscode.window.showWarningMessage('Markdown to SingleHtml : File does not create!');
                return;
            }
            await _sleep(1000);
        }
        const basedir = path.dirname(mdfilename);

        // HTML編集
        /*
        * Cheerio tip
        *    読み込むとき（load）に decodeEntities: false、文字列を出すとき（html）では オプションなし
        *    にすると、日本語がそのまま出てタグはエスケイプしてくれる
        * */
        const $ = cheerio.load(html, { decodeEntities: false });
        // stylesheet
        $('link[rel=stylesheet]').each(function () {
            if ($(this).attr('href').substring(0, 5) === 'file:') {
                // 単にファイルの中身を貼り付けるだけ。  @importには対応してまへん。
                const cssuri = vscode.Uri.parse($(this).attr('href'));
                const css = fs.readFileSync(cssuri.fsPath, 'utf8');
                $(this).parent().append(`<style>${css}</style>`)
                $(this).remove();
            }
        });
        // 画像
        const imgs = $('img');
        console.log(imgs.length);
        for (let i = 0; i < imgs.length; i++) {        // .each は await が効かないのでfor文で回す
            const $img = $(imgs[i]);
            await convImage(basedir, $img);
        }
        // scriptは削除する(marmaid.jsは使わない)
        $('script').each(function () {
            $(this).remove();
        });
        // ------------------
        console.log("menu");
        // メニューの作成
        if (vscode.workspace.getConfiguration('md2singlehtml')['generateToc']) {
            // コンテンツを<div id="area__content">で囲む
            $('body').html('\n<div id="area__content">' + $('body').html() + '</div>\n');
            // メニューを作る
            $('body').append('\n<div id="area__menu"><div><p>Index</p><ul></ul></div></div>\n');
            const $ul = $('#area__menu ul');
            $('h1, h2').each(function () {
                const classnm = $(this).get(0).tagName.toLowerCase() === 'h1' ? 'menu-h1' : 'menu-h2';
                $ul.append('\n<li><a href="#' + $(this).attr('id') + '" class="' + classnm + '">' + $(this).text() + "</a></li>");
            });
            // CSS挿入
            $('head').append('\n<style>' + getDefaultMenuCss() + '</style>\n');
        }
        // ------------------

        // 追加CSS読み込み
        const extCss = vscode.workspace.getConfiguration('md2singlehtml')['styleSheet'] || '';
        if (extCss) {
            const extCssPath = path.join(path.dirname(docUri.fsPath), extCss);
            if (isExistsPath(extCssPath)) {
                const extCssStyle = fs.readFileSync(extCssPath, 'utf8');
                $('head').append(`\n<style>${extCssStyle}</style>\n`)
            }
        }

        // 完了
        $('<!-- Generated by "Markdown to SingleHtml" VSCode extension [https://github.com/kirishu/md2singlehtml.git] -->\n').insertBefore('html');
        const content = $.html($.root()).replaceAll('\r\n', '\n');     // , { decodeEntities: true }
        console.log('finish editHtml');

        // 元のHtmlファイルを削除する
        fs.unlinkSync(htmlfilename);

        // 編集したHtmlをファイルに出力
        const outfilename = path.join(getOutputDir(docUri), path.basename(htmlfilename));
        fs.writeFileSync(outfilename, content);

        vscode.window.showInformationMessage('[Markdown to SingleHtml] Successful conversion to SingleHtml.');

    });    // vscode.window.withProgress
}

function isExistsPath(path) {
    if (path.length === 0) {
        return false;
    }
    try {
        fs.accessSync(path);
        return true;
    } catch (error) {
        console.warn(error.message);
        return false;
    }
}

function convImage(basedir, $img) {
    return new Promise((resolve, reject) => {
        const src = $img.attr('src');
        console.log(src);
        try {
            if (src.substr(0, 4).toLocaleLowerCase() === 'http') {
                axios
                    .get(src, { 'Content-Type': 'utf-8' })
                    .then((res) => {
                        console.log(res.status);
                        const enc64 = Buffer.from(res.data).toString('base64');
                        $img.attr('src', `data:image/svg+xml;charset=utf8;base64,${enc64}`);
                        resolve();
                    })
                    .catch((error) => {
                        console.log(error);
                        $img.remove();
                        resolve();
                    });
            } else {
                const imgfile = path.join(basedir, src);
                if (isExistsPath(imgfile)) {
                    var enc64 = fs.readFileSync(imgfile, 'base64');
                    let ext = path.extname(imgfile).replace('.', '');
                    if (ext === 'svg') {
                        ext = 'svg+xml';
                    } else if (ext === 'jpg') {
                        ext = 'jpeg';
                    }
                    $img.attr('src', `data:image/${ext};base64,${enc64}`);
                    resolve();
                } else {
                    $img.remove();
                    resolve();
                }
            }
        } catch (err) {
            console.log(err);
            reject();
        }
    });
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getOutputDir(resource) {
    try {
        var outputDir;
        var outputDirectory = vscode.workspace.getConfiguration('md2singlehtml')['outputDirectory'] || '';
        if (outputDirectory.length === 0) {
            return path.dirname(resource.fsPath);
        }

        // Use a home directory relative path If it starts with ~.
        if (outputDirectory.indexOf('~') === 0) {
            outputDir = outputDirectory.replace(/^~/, os.homedir());
            mkdir(outputDir);
            return outputDir;
        }

        // Use path if it is absolute
        if (path.isAbsolute(outputDirectory)) {
            if (!isExistsDir(outputDirectory)) {
                showErrorMessage(`The output directory specified by the md2singlehtml.outputDirectory option does not exist.\
                    Check the md2singlehtml.outputDirectory option. ` + outputDirectory);
                return;
            }
            return outputDirectory;
        }

        // Otherwise look relative to the markdown file
        outputDir = path.join(path.dirname(resource.fsPath), outputDirectory);
        mkdir(outputDir);
        return outputDir;
    } catch (error) {
        showErrorMessage('getOutputDir()', error);
    }
}

function mkdir(path) {
    if (isExistsDir(path)) {
        return;
    }
    var mkdirp = require('mkdirp');
    return mkdirp.sync(path);
}

function isExistsDir(dirname) {
    if (dirname.length === 0) {
        return false;
    }
    try {
        if (fs.statSync(dirname).isDirectory()) {
            return true;
        } else {
            console.warn('Directory does not exist!');
            return false;
        }
    } catch (error) {
        console.warn(error.message);
        return false;
    }
}

function showErrorMessage(msg, error) {
    vscode.window.showErrorMessage('ERROR: ' + msg);
    console.log('ERROR: ' + msg);
    if (error) {
        vscode.window.showErrorMessage(error.toString());
        console.log(error);
    }
}

function getDefaultMenuCss() {
    return `
    body {
        margin-bottom: 6em;
    }

    #area__menu {
        float: left;
        position: fixed;
        top: 0;
        left: 0;
        overflow: auto;
        height: 100%;
        display: block;
        width: 210px;
        border-right: 1px solid #aaa;
    }

    #area__menu div {
        overflow: hidden;
        padding-left: 10px;
        margin-bottom: 20px;
    }

    #area__menu p {
        font-size: 16px;
        font-weight: bold;
        color: #000;
        margin: 0;
    }

    #area__menu div ul {
        margin-bottom: 20px;
        margin: 0;
        padding: 0;
        list-style-type: none;
    }

    #area__menu div ul li {
        margin: 0;
        padding: 0;
        position: static;
        font-size: 9pt;
        line-height: 2.2em;
        cursor: pointer;
    }

    #area__menu a {
        display: block;
        color: #005282;
        text-decoration: none;
    }

    #area__menu a:hover {
        text-decoration: underline;
    }

    #area__menu a.menu-h1 {
        margin-left: 0;
    }

    #area__menu a.menu-h2 {
        margin-left: 20px;
    }

    #area__content {
        padding-left: 10px;
        margin-left: 210px;
    }

    @media print {
        /* 印刷時 */
        #area__menu {
            display: none;
        }
        #area__content {
            padding-left: 0;
            margin-left: 0;
        }
    }`
}

// { modal: true },
// { title: "OK", isCloseAffordance: false },
// { title: "Cancel", isCloseAffordance: true }


async function convertAll() {
    vscode.window.showInformationMessage(
        'Do you want to convert all the files?', 'Ok', 'Cancel'
    ).then((x) => {
        if (x === 'Ok') {
            try {
                // check active window
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    vscode.window.showWarningMessage('Markdown to SingleHtml : No active Editor!');
                    return;
                }
                // check markdown mode
                const mode = editor.document.languageId;
                if (mode != 'markdown') {
                    vscode.window.showWarningMessage('Markdown to SingleHtml : It is not a markdown mode!');
                    return;
                }
                vscode.window.setStatusBarMessage('');

                // 選択中のmdファイルと同じフォルダ内のmdファイルを取得
                //console.log(path.dirname(editor.document.uri.fsPath));
                const foldername = path.dirname(editor.document.uri.fsPath);
                const mdfiles = fs.readdirSync(foldername, { withFileTypes: true })  // 同期でファイル読み込み
                    .filter(dirent => dirent.isFile()).map(({ name }) => name)  // フォルダ除外
                    .filter(function (file) {
                        return path.extname(file).toLowerCase() === '.md';  // 拡張子mdだけ
                    });
                if (!mdfiles) {
                    showErrorMessage('No markdown file! ');
                    return;
                }

                for (const file of mdfiles) {
                    const uri = vscode.Uri.file(path.join(foldername, file));
                    mdpdf.convertToHtml(uri);
                }

                for (const file of mdfiles) {
                    const uri = vscode.Uri.file(path.join(foldername, file));
                    editHtml(uri);
                }


            } catch (error) {
                showErrorMessage('Markdown to SingleHtml()', error);
            }
        } else {
            console.log('Cancel');
            return;
            // Run function
        }
    });
}