/**
 * Markdown PDFのソースをコピペしています
 * https://github.com/yzane/vscode-markdown-pdf.git
 */

'use strict';
var vscode = require('vscode');
var path = require('path');
var fs = require('fs');
var url = require('url');
var os = require('os');

/**
 *
 * @param {uri} uri Markdownファイル
 */
async function convertToHtml(uri) {
    console.log(`uri : ${uri}`);

    var mdfilename = uri.fsPath;
    var text = fs.readFileSync(mdfilename, 'utf8');
    var content = convertMarkdownToHtml(mdfilename, text);
    var html = makeHtml(content, uri);

    var htmlfilename = mdfilename.replace('.md', '.html');
    fs.writeFile(htmlfilename, html, 'utf-8', (error) => {
        console.log(error);
    });
}

exports.convertToHtml = async function(uri) { await convertToHtml(uri); };

// --------------------

function convertMarkdownToHtml(filename, text) {
    var grayMatter = require("gray-matter");
    var matterParts = grayMatter(text);

    try {
        try {
            var statusbarmessage = vscode.window.setStatusBarMessage('$(markdown) Converting (convertMarkdownToHtml) ...');
            var hljs = require('highlight.js');
            //***var breaks = setBooleanValue(matterParts.data.breaks, vscode.workspace.getConfiguration('markdown-pdf')['breaks']);
            var breaks = true;
            var md = require('markdown-it')({
                html: true,
                breaks: breaks,
                highlight: function (str, lang) {

                    if (lang && lang.match(/\bmermaid\b/i)) {
                        return `<div class="mermaid">${str}</div>`;
                    }

                    if (lang && hljs.getLanguage(lang)) {
                        try {
                            str = hljs.highlight(lang, str, true).value;
                        } catch (error) {
                            str = md.utils.escapeHtml(str);

                            showErrorMessage('markdown-it:highlight', error);
                        }
                    } else {
                        str = md.utils.escapeHtml(str);
                    }
                    return '<pre class="hljs"><code><div>' + str + '</div></code></pre>';
                }
            });
        } catch (error) {
            statusbarmessage.dispose();
            showErrorMessage('require(\'markdown-it\')', error);
        }

        // convert the img src of the markdown
        var cheerio = require('cheerio');
        var defaultRender = md.renderer.rules.image;
        md.renderer.rules.image = function (tokens, idx, options, env, self) {
            var token = tokens[idx];
            var href = token.attrs[token.attrIndex('src')][1];
            // console.log("original href: " + href);
            href = decodeURIComponent(href).replace(/("|')/g, '');
            // console.log("converted href: " + href);
            token.attrs[token.attrIndex('src')][1] = href;
            // // pass token to default renderer.
            return defaultRender(tokens, idx, options, env, self);
        };

        // convert the img src of the html
        md.renderer.rules.html_block = function (tokens, idx) {
            var html = tokens[idx].content;
            var $ = cheerio.load(html);
            $('img').each(function () {
                var src = $(this).attr('src');
                var href = convertImgPath(src, filename);
                $(this).attr('src', href);
            });
            return $.html();
        };

        // checkbox
        md.use(require('markdown-it-checkbox'));

        // emoji
        //***var emoji_f = setBooleanValue(matterParts.data.emoji, vscode.workspace.getConfiguration('markdown-pdf')['emoji']);
        var emoji_f = true;
        if (emoji_f) {
            var emojies_defs = require(path.join(__dirname, 'data', 'emoji.json'));
            try {
                var options = {
                    defs: emojies_defs
                };
            } catch (error) {
                statusbarmessage.dispose();
                showErrorMessage('markdown-it-emoji:options', error);
            }
            md.use(require('markdown-it-emoji'), options);
            md.renderer.rules.emoji = function (token, idx) {
                var emoji = token[idx].markup;
                var emojipath = path.join(__dirname, 'node_modules', 'emoji-images', 'pngs', emoji + '.png');
                var emojidata = readFile(emojipath, null).toString('base64');
                if (emojidata) {
                    return '<img class="emoji" alt="' + emoji + '" src="data:image/png;base64,' + emojidata + '" />';
                } else {
                    return ':' + emoji + ':';
                }
            };
        }

        // toc
        // https://github.com/leff/markdown-it-named-headers
        var options = {
            slugify: Slug
        }
        md.use(require('markdown-it-named-headers'), options);

        // markdown-it-container
        // https://github.com/markdown-it/markdown-it-container
        md.use(require('markdown-it-container'), '', {
            validate: function (name) {
                return name.trim().length;
            },
            render: function (tokens, idx) {
                if (tokens[idx].info.trim() !== '') {
                    return `<div class="${tokens[idx].info.trim()}">\n`;
                } else {
                    return `</div>\n`;
                }
            }
        });

        // PlantUML
        // https://github.com/gmunguia/markdown-it-plantuml
        var plantumlOptions = {
            openMarker: matterParts.data.plantumlOpenMarker || '@startuml',
            closeMarker: matterParts.data.plantumlCloseMarker || '@enduml',
            server: 'https://www.plantuml.com/plantuml' || ''
        }
        md.use(require('markdown-it-plantuml'), plantumlOptions);

        // markdown-it-include
        // https://github.com/camelaissani/markdown-it-include
        // the syntax is :[alt-text](relative-path-to-file.md)
        // https://talk.commonmark.org/t/transclusion-or-including-sub-documents-for-reuse/270/13
        //***if (vscode.workspace.getConfiguration('markdown-pdf')['markdown-it-include']['enable']) {
            md.use(require("markdown-it-include"), {
                root: path.dirname(filename),
                includeRe: /:\[.+\]\((.+\..+)\)/i
            });
        //*** */}

        statusbarmessage.dispose();
        return md.render(matterParts.content);

    } catch (error) {
        statusbarmessage.dispose();
        showErrorMessage('convertMarkdownToHtml()', error);
    }
}


/*
 * https://github.com/microsoft/vscode/blob/ca4ceeb87d4ff935c52a7af0671ed9779657e7bd/extensions/markdown-language-features/src/slugify.ts#L26
 */
function Slug(string) {
    try {
        var stg = encodeURI(
            string.trim()
                .toLowerCase()
                .replace(/\s+/g, '-') // Replace whitespace with -
                .replace(/[\]\[\!\'\#\$\%\&\(\)\*\+\,\.\/\:\;\<\=\>\?\@\\\^\_\{\|\}\~\`。，、；：？！…—·ˉ¨‘’“”々～‖∶＂＇｀｜〃〔〕〈〉《》「」『』．〖〗【】（）［］｛｝]/g, '') // Remove known punctuators
                .replace(/^\-+/, '') // Remove leading -
                .replace(/\-+$/, '') // Remove trailing -
        );
        return stg;
    } catch (error) {
        showErrorMessage('Slug()', error);
    }
}

/*
 * make html
 */
function makeHtml(data, uri) {
    try {
        // read styles
        var style = '';
        style += readStyles(uri);

        // get title
        var title = path.basename(uri.fsPath);

        // read template
        var filename = path.join(__dirname, 'template', 'template.html');
        var template = readFile(filename);

        // *** Marmaidは使わない。というか基本的にスクリプトなしで出力する。***
        // // read mermaid javascripts
        // var mermaidServer = vscode.workspace.getConfiguration('markdown-pdf')['mermaidServer'] || '';
        // var mermaid = '<script src=\"' + mermaidServer + '\"></script>';

        // compile template
        var mustache = require('mustache');

        var view = {
            title: title,
            style: style,
            content: data,
            //mermaid: mermaid
            mermaid: ''
        };
        return mustache.render(template, view);
    } catch (error) {
        showErrorMessage('makeHtml()', error);
    }
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

function deleteFile(path) {
    var rimraf = require('rimraf')
    rimraf.sync(path);
}

function getOutputDir(filename, resource) {
    try {
        var outputDir;
        if (resource === undefined) {
            return filename;
        }
        //var outputDirectory = vscode.workspace.getConfiguration('markdown-pdf')['outputDirectory'] || '';
        var outputDirectory = '../' || '';
        if (outputDirectory.length === 0) {
            return filename;
        }

        // Use a home directory relative path If it starts with ~.
        if (outputDirectory.indexOf('~') === 0) {
            outputDir = outputDirectory.replace(/^~/, os.homedir());
            mkdir(outputDir);
            return path.join(outputDir, path.basename(filename));
        }

        // Use path if it is absolute
        if (path.isAbsolute(outputDirectory)) {
            if (!isExistsDir(outputDirectory)) {
                showErrorMessage(`The output directory specified by the markdown-pdf.outputDirectory option does not exist.\
            Check the markdown-pdf.outputDirectory option. ` + outputDirectory);
                return;
            }
            return path.join(outputDirectory, path.basename(filename));
        }

        // Use a workspace relative path if there is a workspace and markdown-pdf.outputDirectoryRootPath = workspace
        var outputDirectoryRelativePathFile = vscode.workspace.getConfiguration('markdown-pdf')['outputDirectoryRelativePathFile'];
        let root = vscode.workspace.getWorkspaceFolder(resource);
        if (outputDirectoryRelativePathFile === false && root) {
            outputDir = path.join(root.uri.fsPath, outputDirectory);
            mkdir(outputDir);
            return path.join(outputDir, path.basename(filename));
        }

        // Otherwise look relative to the markdown file
        outputDir = path.join(path.dirname(resource.fsPath), outputDirectory);
        mkdir(outputDir);
        return path.join(outputDir, path.basename(filename));
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

function readFile(filename, encode) {
    if (filename.length === 0) {
        return '';
    }
    if (!encode && encode !== null) {
        encode = 'utf-8';
    }
    if (filename.indexOf('file://') === 0) {
        if (process.platform === 'win32') {
            filename = filename.replace(/^file:\/\/\//, '')
                .replace(/^file:\/\//, '');
        } else {
            filename = filename.replace(/^file:\/\//, '');
        }
    }
    if (isExistsPath(filename)) {
        return fs.readFileSync(filename, encode);
    } else {
        return '';
    }
}

function convertImgPath(src, filename) {
    try {
        var href = decodeURIComponent(src);
        href = href.replace(/("|')/g, '')
            .replace(/\\/g, '/')
            .replace(/#/g, '%23');
        var protocol = url.parse(href).protocol;
        if (protocol === 'file:' && href.indexOf('file:///') !== 0) {
            return href.replace(/^file:\/\//, 'file:///');
        } else if (protocol === 'file:') {
            return href;
        } else if (!protocol || path.isAbsolute(href)) {
            href = path.resolve(path.dirname(filename), href).replace(/\\/g, '/')
                .replace(/#/g, '%23');
            if (href.indexOf('//') === 0) {
                return 'file:' + href;
            } else if (href.indexOf('/') === 0) {
                return 'file://' + href;
            } else {
                return 'file:///' + href;
            }
        } else {
            return src;
        }
    } catch (error) {
        showErrorMessage('convertImgPath()', error);
    }
}



function convertImgPath(src, filename) {
    try {
        var href = decodeURIComponent(src);
        href = href.replace(/("|')/g, '')
            .replace(/\\/g, '/')
            .replace(/#/g, '%23');
        var protocol = url.parse(href).protocol;
        if (protocol === 'file:' && href.indexOf('file:///') !== 0) {
            return href.replace(/^file:\/\//, 'file:///');
        } else if (protocol === 'file:') {
            return href;
        } else if (!protocol || path.isAbsolute(href)) {
            href = path.resolve(path.dirname(filename), href).replace(/\\/g, '/')
                .replace(/#/g, '%23');
            if (href.indexOf('//') === 0) {
                return 'file:' + href;
            } else if (href.indexOf('/') === 0) {
                return 'file://' + href;
            } else {
                return 'file:///' + href;
            }
        } else {
            return src;
        }
    } catch (error) {
        showErrorMessage('convertImgPath()', error);
    }
}

function makeCss(filename) {
    try {
        var css = readFile(filename);
        if (css) {
            return '\n<style>\n' + css + '\n</style>\n';
        } else {
            return '';
        }
    } catch (error) {
        showErrorMessage('makeCss()', error);
    }
}

function readStyles(uri) {
    try {
        var includeDefaultStyles;
        var style = '';
        var styles = '';
        var filename = '';
        var i;

        //***includeDefaultStyles = vscode.workspace.getConfiguration('markdown-pdf')['includeDefaultStyles'];
        includeDefaultStyles = true;

        // 1. read the style of the vscode.
        if (includeDefaultStyles) {
            filename = path.join(__dirname, 'styles', 'markdown.css');
            style += makeCss(filename);
        }

        // 2. read the style of the markdown.styles setting.
        if (includeDefaultStyles) {
            styles = vscode.workspace.getConfiguration('markdown')['styles'];
            if (styles && Array.isArray(styles) && styles.length > 0) {
                for (i = 0; i < styles.length; i++) {
                    var href = fixHref(uri, styles[i]);
                    style += '<link rel=\"stylesheet\" href=\"' + href + '\" type=\"text/css\">';
                }
            }
        }

        // 3. read the style of the highlight.js.
        //***var highlightStyle = vscode.workspace.getConfiguration('markdown-pdf')['highlightStyle'] || '';
        //***var ishighlight = vscode.workspace.getConfiguration('markdown-pdf')['highlight'];
        var highlightStyle = 'vs2015.css' || '';
        var ishighlight = true;
        if (ishighlight) {
            if (highlightStyle) {
                var css = highlightStyle || 'github.css';
                filename = path.join(__dirname, 'node_modules', 'highlight.js', 'styles', css);
                style += makeCss(filename);
            } else {
                filename = path.join(__dirname, 'styles', 'tomorrow.css');
                style += makeCss(filename);
            }
        }

        // 4. read the style of the markdown-pdf.
        if (includeDefaultStyles) {
            filename = path.join(__dirname, 'styles', 'markdown-pdf.css');
            style += makeCss(filename);
        }

        // 5. read the style of the markdown-pdf.styles settings.
        //***styles = vscode.workspace.getConfiguration('markdown-pdf')['styles'] || '';
        styles = '';
        if (styles && Array.isArray(styles) && styles.length > 0) {
            for (i = 0; i < styles.length; i++) {
                var href = fixHref(uri, styles[i]);
                style += '<link rel=\"stylesheet\" href=\"' + href + '\" type=\"text/css\">';
            }
        }

        return style;
    } catch (error) {
        showErrorMessage('readStyles()', error);
    }
}

/*
 * vscode/extensions/markdown-language-features/src/features/previewContentProvider.ts fixHref()
 * https://github.com/Microsoft/vscode/blob/0c47c04e85bc604288a288422f0a7db69302a323/extensions/markdown-language-features/src/features/previewContentProvider.ts#L95
 *
 * Extension Authoring: Adopting Multi Root Workspace APIs ?E Microsoft/vscode Wiki
 * https://github.com/Microsoft/vscode/wiki/Extension-Authoring:-Adopting-Multi-Root-Workspace-APIs
 */
function fixHref(resource, href) {
    try {
        if (!href) {
            return href;
        }

        // Use href if it is already an URL
        const hrefUri = vscode.Uri.parse(href);
        if (['http', 'https'].indexOf(hrefUri.scheme) >= 0) {
            return hrefUri.toString();
        }

        // Use a home directory relative path If it starts with ^.
        if (href.indexOf('~') === 0) {
            return vscode.Uri.file(href.replace(/^~/, os.homedir())).toString();
        }

        // Use href as file URI if it is absolute
        if (path.isAbsolute(href)) {
            return vscode.Uri.file(href).toString();
        }

        // Use a workspace relative path if there is a workspace and markdown-pdf.stylesRelativePathFile is false
        //***var stylesRelativePathFile = vscode.workspace.getConfiguration('markdown-pdf')['stylesRelativePathFile'];
        var stylesRelativePathFile = true;
        let root = vscode.workspace.getWorkspaceFolder(resource);
        if (stylesRelativePathFile === false && root) {
            return vscode.Uri.file(path.join(root.uri.fsPath, href)).toString();
        }

        // Otherwise look relative to the markdown file
        return vscode.Uri.file(path.join(path.dirname(resource.fsPath), href)).toString();
    } catch (error) {
        showErrorMessage('fixHref()', error);
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

function setBooleanValue(a, b) {
    if (a === false) {
        return false
    } else {
        return a || b
    }
}