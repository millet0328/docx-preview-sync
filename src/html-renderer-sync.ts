import { WordDocument } from './word-document';
import { BreakType, DomType, IDomNumbering, OpenXmlElement, WmlBreak, WmlCharacter, WmlDrawing, WmlHyperlink, WmlImage, WmlLastRenderedPageBreak, WmlNoteReference, WmlSectionBreak, WmlSymbol, WmlTable, WmlTableCell, WmlTableColumn, WmlTableRow, WmlText, WrapType, } from './document/dom';
import { CommonProperties } from './document/common';
import { Options } from './docx-preview';
import { DocumentElement } from './document/document';
import { WmlParagraph } from './document/paragraph';
import * as _ from 'lodash-es';
import { asArray, escapeClassName, uuid } from './utils';
import { computePointToPixelRatio, updateTabStop } from './javascript';
import { FontTablePart } from './font-table/font-table';
import { FooterHeaderReference, SectionProperties, SectionType } from './document/section';
import { parseLineSpacing } from "./document/spacing-between-lines";
import { Page, PageProps, TreeNode } from './document/page';
import { RunProperties, WmlRun } from './document/run';
import { WmlBookmarkStart } from './document/bookmarks';
import { IDomStyle, Ruleset } from './document/style';
import { WmlBaseNote, WmlEndnote, WmlEndnotes, WmlFootnote, WmlFootnotes } from './notes/elements';
import { ThemePart } from './theme/theme-part';
import { BaseHeaderFooterPart } from './header-footer/parts';
import { Part } from './common/part';
import { VmlElement } from './vml/vml';
import { WmlCommentRangeStart, WmlCommentReference } from './comments/elements';
import Konva from 'konva';
import type { Stage } from 'konva/lib/Stage';
import type { Layer } from 'konva/lib/Layer';
import type { Group } from 'konva/lib/Group';

const ns = {
	html: 'http://www.w3.org/1999/xhtml',
	svg: 'http://www.w3.org/2000/svg',
	mathML: 'http://www.w3.org/1998/Math/MathML',
};

interface CellPos {
	col: number;
	row: number;
}

type CellVerticalMergeType = Record<number, HTMLTableCellElement>;

interface Node_DOM extends Node, Text {
	dataset: DOMStringMap;
}

enum Overflow {
	// 已溢出
	TRUE = 'true',
	// 未溢出
	FALSE = 'false',
	// 插入元素之后，CSS样式的原因，元素自身溢出
	SELF = 'self',
	// 插入元素children之后，全部child溢出
	FULL = 'full',
	// 插入元素children之后，一部分child溢出
	PART = 'part',
	// 未执行溢出检测
	UNKNOWN = 'undetected',
	// 忽略溢出检测
	IGNORE = 'ignore',
}

// HTML渲染器
export class HtmlRendererSync {
	className = 'docx';
	rootSelector: string;
	document: WordDocument;
	options: Options;
	styleMap: Record<string, IDomStyle> = {};
	bodyContainer: HTMLElement;
	wrapper: HTMLElement;
	// 当前操作的Part
	currentPart: Part = null;
	// 系统的PPI
	pointToPixelRatio: number;

	// 当前操作的Page
	currentPage: Page;
	// 表格垂直合并集合，用于嵌套表格
	tableVerticalMerges: CellVerticalMergeType[] = [];
	// 当前Table的垂直合并
	currentVerticalMerge: CellVerticalMergeType = null;
	// 表格行列位置集合，用于嵌套表格
	tableCellPositions: CellPos[] = [];
	// 当前Table的行列位置
	currentCellPosition: CellPos = null;

	footnoteMap: Record<string, WmlFootnote> = {};
	endnoteMap: Record<string, WmlEndnote> = {};
	currentFootnoteIds: string[];
	currentEndnoteIds: string[] = [];
	// 已使用的Header、Footer部分的数组。
	usedHeaderFooterParts: any[] = [];

	defaultTabSize: string;
	// 当前制表位
	currentTabs: any[] = [];

	// Konva框架--stage元素
	konva_stage: Stage;
	// Konva框架--layer元素
	konva_layer: Layer;

	/**
	 * Object对象 => HTML标签
	 *
	 * @param document word文档Object对象
	 * @param bodyContainer HTML生成容器
	 * @param styleContainer CSS样式生成容器
	 * @param options 渲染配置选项
	 */

	async render(document: WordDocument, bodyContainer: HTMLElement, styleContainer: HTMLElement = null, options: Options) {
		// word文档对象
		this.document = document;
		// 渲染选项
		this.options = options;
		// class类前缀
		this.className = options.className;
		// 根元素
		this.rootSelector = options.inWrapper ? `.${this.className}-wrapper` : ':root';
		// 文档CSS样式
		this.styleMap = null;
		// 主体容器
		this.bodyContainer = bodyContainer;
		// 样式容器，可传参指定，默认为主体容器
		styleContainer = styleContainer || bodyContainer;
		// 计算Point/Pixel换算比例
		this.pointToPixelRatio = computePointToPixelRatio();
		// CSS样式生成容器，清空所有CSS样式
		removeAllElements(styleContainer);
		// HTML生成容器，清空所有HTML元素
		removeAllElements(bodyContainer);

		// 添加注释
		appendComment(styleContainer, 'docxjs library predefined styles');
		// 添加默认CSS样式
		styleContainer.appendChild(this.renderDefaultStyle());

		// 主题CSS样式
		if (document.themePart) {
			appendComment(styleContainer, 'docxjs document theme values');
			this.renderTheme(document.themePart, styleContainer);
		}
		// 文档默认CSS样式，包含表格、列表、段落、字体，样式存在继承顺序
		if (document.stylesPart != null) {
			this.styleMap = this.processStyles(document.stylesPart.styles);

			appendComment(styleContainer, 'docxjs document styles');
			styleContainer.appendChild(this.renderStyles(document.stylesPart.styles));
		}
		// 多级列表样式
		if (document.numberingPart) {
			this.processNumberings(document.numberingPart.domNumberings);

			appendComment(styleContainer, "docxjs document numbering styles");
			styleContainer.appendChild(this.renderNumbering(document.numberingPart.domNumberings, styleContainer));
			//styleContainer.appendChild(this.renderNumbering2(document.numberingPart, styleContainer));
		}
		// 字体列表CSS样式
		if (!options.ignoreFonts && document.fontTablePart) {
			this.renderFontTable(document.fontTablePart, styleContainer);
		}
		// 生成脚注部分的Map
		if (document.footnotesPart) {
			this.footnoteMap = _.keyBy(document.footnotesPart.rootElement.children, 'id');
		}
		// 生成尾注部分的Map
		if (document.endnotesPart) {
			this.endnoteMap = _.keyBy(document.endnotesPart.rootElement.children, 'id');
		}
		// 文档设置
		if (document.settingsPart) {
			this.defaultTabSize = document.settingsPart.settings?.defaultTabStop;
		}
		// 根据option生成wrapper
		if (this.options.inWrapper) {
			this.wrapper = this.renderWrapper();
			bodyContainer.appendChild(this.wrapper);
		} else {
			this.wrapper = bodyContainer;
		}
		// 生成Canvas画布元素--Konva框架
		this.renderKonva();
		// 主文档--内容
		await this.renderPages(document.documentPart.body);
		// 渲染完成所有Page, 隐藏Stage
		this.konva_stage.visible(false);
		// 刷新制表符
		this.refreshTabStops();
	}

	// 渲染默认样式
	renderDefaultStyle() {
		const c = this.className;
		const styleText = `
			.${c} { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif }
			.${c}-wrapper { background: gray; padding: 30px; padding-bottom: 0px; display: flex; flex-flow: column; align-items: center; line-height:normal; font-weight:normal; }
			.${c}-wrapper>section.${c} { background: white; box-shadow: 0 0 10px rgba(0, 0, 0, 0.5); margin-bottom: 30px; }
			.${c} { color: black; hyphens: auto; text-underline-position: from-font; }
			section.${c} { box-sizing: border-box; display: flex; flex-flow: column nowrap; position: relative; overflow: hidden; }
            section.${c}>header { position: absolute; top: 0; z-index: 1; display: flex; flex-direction: column; justify-content: flex-end; }
			section.${c}>article { z-index: 1; }
			section.${c}>footer { position: absolute; bottom: 0; z-index: 1; }
			.${c} table { border-collapse: collapse; }
			.${c} table td, .${c} table th { vertical-align: top; }
			.${c} p { margin: 0pt; min-height: 1em; }
			.${c} span { white-space: pre-wrap; overflow-wrap: break-word; }
			.${c} a { color: inherit; text-decoration: inherit; }
			.${c} img, ${c} svg { vertical-align: baseline; }
			.${c} svg { fill: transparent; }
			.${c} .clearfix::after { content: ""; display: block; line-height: 0; clear: both; }
		`;

		return createStyleElement(styleText);
	}

	// 文档CSS主题样式
	renderTheme(themePart: ThemePart, styleContainer: HTMLElement) {
		const variables = {};
		const fontScheme = themePart.theme?.fontScheme;

		if (fontScheme) {
			if (fontScheme.majorFont) {
				variables['--docx-majorHAnsi-font'] = fontScheme.majorFont.latinTypeface;
			}

			if (fontScheme.minorFont) {
				variables['--docx-minorHAnsi-font'] = fontScheme.minorFont.latinTypeface;
			}
		}

		const colorScheme = themePart.theme?.colorScheme;

		if (colorScheme) {
			for (const [k, v] of Object.entries(colorScheme.colors)) {
				variables[`--docx-${k}-color`] = `#${v}`;
			}
		}

		const cssText = this.styleToString(`.${this.className}`, variables);
		styleContainer.appendChild(createStyleElement(cssText));
	}

	// 计算className，小写，默认前缀："docx_"
	processStyleName(className: string): string {
		return className ? `${this.className}_${escapeClassName(className)}` : this.className;
	}

	// 处理样式继承，合并样式规则
	// 在styles中，某一个样式baseOn依赖的styleId一定排在其前面，样式的继承关系是自上而下的，所以，只需要遍历一次，就可以完成所有样式的继承
	processStyles(styles: IDomStyle[]) {
		// 根据id生成style集合
		let stylesMap = _.keyBy(styles, 'id');
		// 遍历依赖关系,合并其样式规则
		for (const childStyle of styles) {
			// 生成其className
			childStyle.cssName = this.processStyleName(childStyle.id);
			// 跳过基础Base样式
			if (childStyle.basedOn === null) {
				continue;
			}
			// 查询其所依赖的父级style
			const parentStyle = stylesMap[childStyle.basedOn];

			if (parentStyle) {
				// 深度合并父级的段落、Run属性
				if (parentStyle?.paragraphProps) {
					childStyle.paragraphProps = _.merge({}, parentStyle?.paragraphProps, childStyle.paragraphProps);
				}
				if (parentStyle?.runProps) {
					childStyle.runProps = _.merge({}, parentStyle?.runProps, childStyle.runProps);
				}
				// 遍历父级的样式规则
				for (let parentRuleset of parentStyle.rulesets) {
					// 根据target查找子级的样式规则
					let childRuleset: Ruleset = childStyle.rulesets.find(r => r.target == parentRuleset.target);

					if (childRuleset) {
						// 存在，深度合并，子级覆盖父级的样式规则
						childRuleset.declarations = _.merge({}, parentRuleset.declarations, childRuleset.declarations);
					} else {
						// 不存在，尾部添加
						childStyle.rulesets.push({ ...parentRuleset });
					}
				}
			} else if (this.options.debug) {
				console.warn(`Can't find base style ${childStyle.basedOn}`);
			}
		}

		return stylesMap;
	}

	// 生成style样式
	renderStyles(styles: IDomStyle[]): HTMLElement {
		let styleText = "";
		for (const style of styles) {
			// TODO 处理链接样式:linked，注意两者互相链接，互相引用

			for (const ruleset of style.rulesets) {
				//TODO temporary disable modifier until test it well
				let selector = `${style.label ?? ''}.${style.cssName}`; //${subStyle.mod ?? ''}
				// 样式目标不匹配，追加子级元素样式目标
				if (style.label !== ruleset.target) {
					selector += ` ${ruleset.target}`;
				}
				// 处理默认样式
				if (style.isDefault) {
					selector = `.${this.className} ${style.label}, ` + selector;
				}

				styleText += this.styleToString(selector, ruleset.declarations);
			}
		}

		return createStyleElement(styleText);
	}

	processNumberings(numberings: IDomNumbering[]) {
		for (const num of numberings.filter(n => n.pStyleName)) {
			const style = this.findStyle(num.pStyleName);

			if (style?.paragraphProps?.numbering) {
				style.paragraphProps.numbering.level = num.level;
			}
		}
	}

	renderNumbering(numberings: IDomNumbering[], styleContainer: HTMLElement) {
		let styleText = '';
		const resetCounters = [];

		for (const num of numberings) {
			const selector = `p.${this.numberingClass(num.id, num.level)}`;
			let listStyleType = 'none';

			if (num.bullet) {
				const valiable = `--${this.className}-${num.bullet.src}`.toLowerCase();

				styleText += this.styleToString(`${selector}:before`, {
					"content": "' '",
					"display": "inline-block",
					"background": `var(${valiable})`
				}, num.bullet.style);

				this.document.loadNumberingImage(num.bullet.src).then(data => {
					const text = `${this.rootSelector} { ${valiable}: url(${data}) }`;
					styleContainer.appendChild(createStyleElement(text));
				});
			} else if (num.levelText) {
				const counter = this.numberingCounter(num.id, num.level);
				const counterReset = counter + ' ' + (num.start - 1);
				if (num.level > 0) {
					styleText += this.styleToString(`p.${this.numberingClass(num.id, num.level - 1)}`, {
						"counter-reset": counterReset
					});
				}
				// reset all level counters with start value
				resetCounters.push(counterReset);

				styleText += this.styleToString(`${selector}:before`, {
					"content": this.levelTextToContent(num.levelText, num.suff, num.id, this.numFormatToCssValue(num.format)),
					"counter-increment": counter,
					...num.rStyle,
				});
			} else {
				listStyleType = this.numFormatToCssValue(num.format);
			}

			styleText += this.styleToString(selector, {
				display: 'list-item',
				'list-style-position': 'inside',
				'list-style-type': listStyleType,
				...num.pStyle,
			});
		}

		if (resetCounters.length > 0) {
			styleText += this.styleToString(this.rootSelector, {
				'counter-reset': resetCounters.join(' '),
			});
		}

		return createStyleElement(styleText);
	}

	numberingClass(id: string, lvl: number) {
		return `${this.className}-num-${id}-${lvl}`;
	}

	styleToString(selectors: string, declarations: Record<string, string>, cssText: string = null) {
		let result = `${selectors} {\r\n`;

		for (const key in declarations) {
			if (key.startsWith('$')) {
				continue;
			}

			result += `  ${key}: ${declarations[key]};\r\n`;
		}

		if (cssText) {
			result += cssText;
		}

		return result + '}\r\n';
	}

	numberingCounter(id: string, lvl: number) {
		return `${this.className}-num-${id}-${lvl}`;
	}

	levelTextToContent(text: string, suff: string, id: string, numformat: string) {
		const suffMap = {
			tab: '\\9',
			space: '\\a0',
		};

		const result = text.replace(/%\d*/g, s => {
			const lvl = parseInt(s.substring(1), 10) - 1;
			return `"counter(${this.numberingCounter(id, lvl)}, ${numformat})"`;
		});

		return `"${result}${suffMap[suff] ?? ''}"`;
	}

	numFormatToCssValue(format: string) {
		const mapping = {
			none: 'none',
			bullet: 'disc',
			decimal: 'decimal',
			lowerLetter: 'lower-alpha',
			upperLetter: 'upper-alpha',
			lowerRoman: 'lower-roman',
			upperRoman: 'upper-roman',
			decimalZero: 'decimal-leading-zero', // 01,02,03,...
			// ordinal: "", // 1st, 2nd, 3rd,...
			// ordinalText: "", //First, Second, Third, ...
			// cardinalText: "", //One,Two Three,...
			// numberInDash: "", //-1-,-2-,-3-, ...
			// hex: "upper-hexadecimal",
			aiueo: 'katakana',
			aiueoFullWidth: 'katakana',
			chineseCounting: 'simp-chinese-informal',
			chineseCountingThousand: 'simp-chinese-informal',
			chineseLegalSimplified: 'simp-chinese-formal', // 中文大写
			chosung: 'hangul-consonant',
			ideographDigital: 'cjk-ideographic',
			ideographTraditional: 'cjk-heavenly-stem', // 十天干
			ideographLegalTraditional: 'trad-chinese-formal',
			ideographZodiac: 'cjk-earthly-branch', // 十二地支
			iroha: 'katakana-iroha',
			irohaFullWidth: 'katakana-iroha',
			japaneseCounting: 'japanese-informal',
			japaneseDigitalTenThousand: 'cjk-decimal',
			japaneseLegal: 'japanese-formal',
			thaiNumbers: 'thai',
			koreanCounting: 'korean-hangul-formal',
			koreanDigital: 'korean-hangul-formal',
			koreanDigital2: 'korean-hanja-informal',
			hebrew1: 'hebrew',
			hebrew2: 'hebrew',
			hindiNumbers: 'devanagari',
			ganada: 'hangul',
			taiwaneseCounting: 'cjk-ideographic',
			taiwaneseCountingThousand: 'cjk-ideographic',
			taiwaneseDigital: 'cjk-decimal',
		};

		return mapping[format] ?? format;
	}

	// renderNumbering2(numberingPart: NumberingPartProperties, container: HTMLElement): HTMLElement {
	//     let css = "";
	//     let numberingMap = keyBy(numberingPart.abstractNumberings, x => x.id);
	//     let bulletMap = keyBy(numberingPart.bulletPictures, x => x.id);
	//     let topCounters = [];
	//
	//     for(let num of numberingPart.numberings) {
	//         let absNum = numberingMap[num.abstractId];
	//
	//         for(let lvl of absNum.levels) {
	//             let className = this.numberingClass(num.id, lvl.level);
	//             let listStyleType = "none";
	//
	//             if(lvl.text && lvl.format == 'decimal') {
	//                 let counter = this.numberingCounter(num.id, lvl.level);
	//
	//                 if (lvl.level > 0) {
	//                     css += this.styleToString(`p.${this.numberingClass(num.id, lvl.level - 1)}`, {
	//                         "counter-reset": counter
	//                     });
	//                 } else {
	//                     topCounters.push(counter);
	//                 }
	//
	//                 css += this.styleToString(`p.${className}:before`, {
	//                     "content": this.levelTextToContent(lvl.text, num.id),
	//                     "counter-increment": counter
	//                 });
	//             } else if(lvl.bulletPictureId) {
	//                 let pict = bulletMap[lvl.bulletPictureId];
	//                 let variable = `--${this.className}-${pict.referenceId}`.toLowerCase();
	//
	//                 css += this.styleToString(`p.${className}:before`, {
	//                     "content": "' '",
	//                     "display": "inline-block",
	//                     "background": `var(${variable})`
	//                 }, pict.style);
	//
	//                 this.document.loadNumberingImage(pict.referenceId).then(data => {
	//                     var text = `.${this.className}-wrapper { ${variable}: url(${data}) }`;
	//                     container.appendChild(createStyleElement(text));
	//                 });
	//             } else {
	//                 listStyleType = this.numFormatToCssValue(lvl.format);
	//             }
	//
	//             css += this.styleToString(`p.${className}`, {
	//                 "display": "list-item",
	//                 "list-style-position": "inside",
	//                 "list-style-type": listStyleType,
	//                 //TODO
	//                 //...num.style
	//             });
	//         }
	//     }
	//
	//     if (topCounters.length > 0) {
	//         css += this.styleToString(`.${this.className}-wrapper`, {
	//             "counter-reset": topCounters.join(" ")
	//         });
	//     }
	//
	//     return createStyleElement(css);
	// }

	// 字体列表CSS样式
	renderFontTable(fontsPart: FontTablePart, styleContainer: HTMLElement) {
		for (const f of fontsPart.fonts) {
			for (const ref of f.embedFontRefs) {
				this.document.loadFont(ref.id, ref.key).then(fontData => {
					const cssValues = {
						'font-family': f.name,
						src: `url(${fontData})`,
					};

					if (ref.type == 'bold' || ref.type == 'boldItalic') {
						cssValues['font-weight'] = 'bold';
					}

					if (ref.type == 'italic' || ref.type == 'boldItalic') {
						cssValues['font-style'] = 'italic';
					}

					appendComment(styleContainer, `docxjs ${f.name} font`);
					const cssText = this.styleToString('@font-face', cssValues);
					styleContainer.appendChild(createStyleElement(cssText));
					this.refreshTabStops();
				});
			}
		}
	}

	// 生成父级容器
	renderWrapper() {
		return createElement('div', { className: `${this.className}-wrapper` });
	}

	// 复制CSS样式
	copyStyleProperties(input: Record<string, string>, output: Record<string, string>, attrs: string[] = null): Record<string, string> {
		if (!input) {
			return output;
		}
		if (output == null) {
			output = {};
		}
		if (attrs == null) {
			attrs = Object.getOwnPropertyNames(input);
		}

		for (const key of attrs) {
			if (input.hasOwnProperty(key) && !output.hasOwnProperty(key))
				output[key] = input[key];
		}

		return output;
	}

	// 递归明确元素parent父级关系
	processElement(element: OpenXmlElement) {
		if (element.children) {
			for (const e of element.children) {
				// 指向父级元素
				e.parent = element;
				// 标识其level层级
				e.level = element?.level + 1;
				// 判断类型
				if (e.type == DomType.Table) {
					// 处理表格style样式
					this.processTable(e);
					this.processElement(e);
				} else {
					// 递归渲染
					this.processElement(e);
				}
			}
		}
	}

	// 处理表格style样式
	processTable(table: WmlTable) {
		for (const r of table.children) {
			for (const c of r.children) {
				c.cssStyle = this.copyStyleProperties(table.cellStyle, c.cssStyle, [
					'border-left',
					'border-right',
					'border-top',
					'border-bottom',
					'padding-left',
					'padding-right',
					'padding-top',
					'padding-bottom',
				]);
			}
		}
	}

	/*
	 * section与page概念区别
	 * 章节(section)是根据内容的逻辑结构和组织来划分的，不同章节设置独立的格式。
	 * 页面是文档实际呈现的物理单位，而章节则是逻辑上的分割点。
	 */

	// TODO 表格中也含有lastRenderedPageBreak，可以拆分表格
	// 初次拆分，根据分页符号拆分页面
	splitPageBySymbol(documentElement: DocumentElement): Page[] {
		// 深拷贝原始数据
		let root: DocumentElement = _.cloneDeep(documentElement);
		// 当前操作page，children数组包含子元素
		let currentPage: Page = new Page({ isSplit: true } as PageProps);
		// 拆分页面的结果集合
		let pages: Page[] = [];

		// 创建新的页面
		function startNewPage() {
			if (currentPage.children.length > 0) {
				pages.push(currentPage);
				currentPage = new Page({ isSplit: true } as PageProps);
			}
		}

		// 根据分页符号拆分段落
		const splitElementsBySymbol = (el: TreeNode, ancestors: TreeNode[]) => {
			// TODO 忽略元素类型集合，多个元素拆分失败
			let ignoredElementTypes = new Set([DomType.BookmarkStart]);
			// 节属性
			if (el.type === DomType.Paragraph) {
				// 查找内置默认段落样式
				const default_paragraph_style = this.findStyle(el?.styleName);
				// 检测段落内置样式是否存在段前分页
				if (default_paragraph_style?.paragraphProps?.pageBreakBefore) {
					// 去除当前段落
					let paragraph = currentPage.stack.pop();
					// 将当前break元素左侧所有元素作为page的子元素
					currentPage.children = parseToTree(currentPage.stack);
					// 开始新的Page
					startNewPage();
					// 重置段落prev
					paragraph.prev = null;
					// 将当前段落添加到下一页page中
					currentPage.stack = [paragraph];
					return;
				}
				// 节属性，代表分节符，包含页眉、页脚、页码、页边距等属性
				const sectProps: SectionProperties = el.props?.sectionProperties;
				// because of table or TOC exist, current page is not split
				if (currentPage.isSplit === false && sectProps === undefined) {
					return;
				}
				// 无论节属性是否存在，都需要添加到当前page中，后续将会从尾至头依次赋值节属性
				currentPage.sectProps = sectProps;
			}
			// table
			if (el.type === DomType.Table) {
				// 仅当isSplit === true，则标记当前page：未拆分，需要渲染期进行拆分
				if (currentPage.isSplit) {
					currentPage.isSplit = false;
				}
			}
			// TOC:table of content
			if (el.type === DomType.Hyperlink) {
				// 检测链接是否存在目录
				const exist_TOC: boolean = (el as WmlHyperlink)?.href?.includes('Toc');
				// 仅当isSplit === true，则标记当前page：未拆分，需要渲染期进行拆分
				if (currentPage.isSplit && exist_TOC) {
					currentPage.isSplit = false;
				}
			}
			// lastRenderedPageBreak
			if (el.type === DomType.LastRenderedPageBreak) {
				if (currentPage.isSplit === false) {
					return;
				}
				// 追溯其父级以及祖先元素，一直追溯至根节点；left：统计左侧相邻兄弟元素数量，remove：即将移除元素id的集合
				let { left, removedElementIds, ignoredElementIds } = checkAncestors(el);
				// 查找其祖先元素中的paragraph元素
				let paragraph = ancestors.find(node => node.type === DomType.Paragraph);
				// 判断是否拆分段落,注意忽略某些元素类型
				let isSplitParagraph = currentPage.stack.some(node => {
					// 段落子元素
					if (node.parent.uuid === paragraph?.uuid) {
						// 默认node.prev不存在
						let isExist = false;
						// 检测node是否存在prev元素
						if (node.prev) {
							// 检测prev元素是否忽略类型
							let isIgnored = ignoredElementTypes.has(node.prev.type);
							// prev元素不是忽略类型,存在prev兄弟元素
							if (isIgnored === false) {
								isExist = true;
							}
						}
						return isExist;
					}
					return false;
				});
				// left数量 > 0，说明左侧存在元素，则生成新的page
				if (left > 0) {
					// 添加当前break元素id至移除集合
					removedElementIds.push(el.uuid);
					// 忽略元素集合
					let ignoredElements = currentPage.stack.filter(node => ignoredElementIds.includes(node.uuid));
					// 根据移除集合，删除元素
					currentPage.stack = currentPage.stack.filter(node => !removedElementIds.includes(node.uuid));
					// 将当前break元素左侧所有元素作为page的子元素
					currentPage.children = parseToTree(currentPage.stack);
					// 拆分元素
					startNewPage();
					// 忽略元素要重新在下一页生成，否则会丢失
					currentPage.stack.push(...ignoredElements);
					// 在下一页中生成lastRenderedPageBreak相关的元素
					currentPage.stack.push(el);
					// 将祖先元素添加入path集合
					let extraAncestors = ancestors.map((ancestor: TreeNode) => {
						let copy = _.cloneDeep(ancestor);
						// 修改lastRenderedPageBreak的祖先元素prev指针为null
						copy.prev = null;
						// 段落拆分之后，下一页段落，重设缩进为0
						if (copy.type === DomType.Paragraph && isSplitParagraph) {
							copy.cssStyle['text-indent'] = '0'
						}
						return copy;
					});
					currentPage.stack.push(...extraAncestors);

				}

				/*
				* 校验lastRenderedPageBreak所有祖先元素，
				* 返回值：
				* left:统计左侧相邻兄弟元素数量;
				* removeElementIds:即将移除元素id的集合;
				* ignoredElementIds:即将忽略元素id的集合;
				* */
				function checkAncestors(el: TreeNode) {
					// 即将忽略元素id的集合
					let ignoredElementIds: string[] = [];
					// 即将移除元素id的集合
					let removedElementIds: string[] = [];
					// el左侧存在兄弟元素数量
					let left: number = 0;
					// 将el与ancestors合并为一个待处理元素数组
					let processingElements = [el, ...ancestors];
					// 子元素数据状态
					let child = { ignoredType: null, uuid: null };
					// 遍历祖先元素
					for (let ancestor of processingElements) {
						// 处理子元素中被忽略的元素
						if (child.ignoredType) {
							// 查找子元素的索引
							let index = ancestor.children.findIndex(node => node.uuid === child.uuid);
							// 切分数组
							let prevElements = ancestor.children.slice(0, index);
							// 倒序排列
							prevElements.reverse();
							// 查找忽略元素，可能存在多个，依次缓存其uuid
							for (let element of prevElements) {
								// 检测元素是否忽略类型
								if (element.type === child.ignoredType) {
									// 将忽略元素uuid添加入忽略元素集合
									ignoredElementIds.push(element.uuid);
									// 将忽略元素uuid添加入移除元素集合
									removedElementIds.push(element.uuid);
								} else {
									// 排除忽略元素，左侧存在兄弟元素，则计数+1，终止递归
									left += 1;
									break;
								}
							}
						}
						// 将当前元素uuid赋值给child
						child.uuid = ancestor.uuid;
						// 检测ancestor是否存在prev元素
						if (ancestor.prev) {
							// 检测prev元素是否忽略
							let isIgnored = ignoredElementTypes.has(ancestor.prev.type);
							if (isIgnored) {
								child.ignoredType = ancestor.prev.type;
							} else {
								// 存在兄弟元素，则计数+1，终止递归
								left += 1;
								break;
							}
						} else {
							// prev元素不存在
							child.ignoredType = null;
							// 排除parentId = root的根节点
							if (ancestor.parent.uuid !== root.uuid) {
								// 将ancestor父级元素的id添加入移除集合
								removedElementIds.push(ancestor.parent.uuid);
							}
						}
					}
					return { left, removedElementIds, ignoredElementIds };
				}
			}
			// page break
			if ((el as WmlBreak).break == BreakType.Page) {
				// 将当前break元素左侧所有元素作为page的子元素
				currentPage.children = parseToTree(currentPage.stack);

				// Mark current page as needing overflow detection, since it was forcibly split
				// by manual page break - this fixes issues with manual page breaks late in document
				// causing one page to get way too much content
				currentPage.isSplit = false;

				// 开始新的Page
				startNewPage();
			}
			// section break
			if (el.type === DomType.SectionBreak) {
				let type = (el as WmlSectionBreak).break;
				switch (type) {
					// Continuous Section Break.
					case SectionType.Continuous:

						break;

					// Column Section Break.
					case SectionType.NextColumn:

						break;

					// Even Page Section Break.
					case SectionType.EvenPage:
					// Odd Page Section Break.
					case SectionType.OddPage:
					// Next Page Section Break.
					case SectionType.NextPage:
					default:
						// 将当前break元素左侧所有元素作为page的子元素
						currentPage.children = parseToTree(currentPage.stack);
						// 开始新的Page
						startNewPage();

						break;
				}
			}
		};
		// 元组Tuple类型
		type TreeTuple = [TreeNode, TreeNode[]];
		// Stack：栈
		let stack: TreeTuple[] = [];
		// 将子元素压入栈
		pushStack(root, []);
		// 遍历路径
		let path: TreeTuple[] = [];
		// 循环条件，栈不为空
		while (stack.length > 0) {
			// 弹出栈顶元素
			let [el, ancestors] = stack.pop();
			// 增加SectionBreak分节符元素
			if (el.type === DomType.Paragraph) {
				// 节属性，代表分节符，包含页眉、页脚、页码、页边距等属性
				const sectProps: SectionProperties = el.props?.sectionProperties;

				if (sectProps) {
					// 节属性生成唯一uuid，每一个节中page均是同一个uuid，代表属于同一个节
					sectProps.sectionId = uuid();
					// 此处添加的SectionBreak元素，应该是下一个节type类型，目前缓存当前节type类型，方便下面重新处理。
					let wmlSectionBreak: WmlSectionBreak = {
						type: DomType.SectionBreak,
						break: sectProps.type ?? SectionType.NextPage,
					}
					// run element
					let wmlRun: WmlRun = {
						type: DomType.Run,
						children: [wmlSectionBreak as OpenXmlElement]
					};

					el.children.push(wmlRun);
				}
			}
			// 记录遍历路径
			path.push([el, ancestors]);
			// 如果该节点有子节点，将当前节点的子节点逆序压入栈，这样可以保证先遍历左子树，继续下一次循环
			pushStack(el, ancestors);
		}
		// 分节符类型：默认为最后一个分节符类型
		let prevSectionType: SectionType = root.sectProps.type ?? SectionType.NextPage;
		// 处理SectionBreak元素类型,倒序设置
		for (let i = path.length - 1; i >= 0; i--) {
			// 获取当前元素
			let [current] = path[i];
			// 检测当前元素是否为SectionBreak元素
			if (current.type === DomType.SectionBreak) {
				// 下一节的类型
				let { break: sectionType } = current as WmlSectionBreak;
				// 设置前一节的类型
				(current as WmlSectionBreak).break = prevSectionType;
				// 缓存
				prevSectionType = sectionType;
			}
		}
		// 正序遍历path路径
		for (let i = 0; i < path.length; i++) {
			// 获取当前元素
			let [node, ancestors] = path[i];
			// 检测是否是当前Page第一个元素,重置其prev
			if (currentPage.stack.length === 0) {
				node.prev = null;
			}
			// 将当前元素缓存至当前页
			currentPage.stack.push(node);
			// 根据分页符号、分节符拆分页面
			splitElementsBySymbol(node, ancestors);
		}
		// 剩余的元素作为最后一个page的子元素
		if (currentPage.stack.length > 0) {
			currentPage.isSplit = false;
			currentPage.children = parseToTree([...currentPage.stack]);
			// 最后一页的sectionProperties,来自root
			currentPage.sectProps = root.sectProps;
			pages.push(currentPage);
		}

		// 倒序压入栈
		function pushStack(elem: TreeNode, ancestors: TreeNode[]) {
			// 子元素
			const len = elem?.children?.length ?? 0;
			// 如果没有子元素，则直接返回
			if (len === 0) {
				return;
			}
			/*
			* ignore Text element's children--Character that will be pushed to stack
			* avoid too many elements in stack
			* side effect:page.stack has no Character element
			* */
			if (elem.type === DomType.Text) {
				return;
			}
			// 用于跟踪前一个兄弟节点,初始化前一个子元素为null
			let nextChild: TreeNode | null = null;
			// 遍历子节点（倒序），设置prev和next指针
			for (let i = len - 1; i >= 0; i--) {
				// 当前元素
				const child = elem.children[i] as TreeNode;
				// 生成元素UUID
				child.uuid = uuid();
				// 标识当前元素的父级
				child.parent = { uuid: elem.uuid, type: elem.type };
				// 如果不是最后一个节点，则设置下一个节点的prev指针
				if (nextChild) {
					nextChild.prev = { uuid: child.uuid, type: child.type };
				}
				// 如果是第一个节点，则设置当前节点的prev指针为null
				if (i === 0) {
					child.prev = null;
				}
				// 更新prevChild为当前节点，以便下一次迭代使用
				nextChild = child;
				// root根节点不能作为祖先节点
				let childAncestors = elem.type === DomType.Document ? [] : [elem, ...ancestors];
				// 压入栈
				stack.push([child, childAncestors]);
			}
		}

		// 将元素转换为树形结构，方便后续操作
		function parseToTree(nodes: TreeNode[]) {
			let firstLevel = nodes.filter((node: TreeNode) => node.parent.uuid === root.uuid);
			// 转换函数
			const parser = function (origin: TreeNode[], root: TreeNode[]) {
				return root.map((parent: TreeNode) => {
					let children: TreeNode[] = origin.filter((child: TreeNode) => child.parent.uuid === parent.uuid);
					if (children.length) {
						return { ...parent, children: parser(origin, children) }
					} else {
						return { ...parent }
					}
				});
			}
			return parser(nodes, firstLevel);
		}

		// 根据继承规则合并sectionProperties中的页眉页脚属性
		let prevSectionProperties: SectionProperties = null;

		for (let page of pages) {
			if (page.sectProps) {
				if (prevSectionProperties?.headerRefs) {
					page.sectProps.headerRefs = _.unionBy(page.sectProps.headerRefs, prevSectionProperties.headerRefs, 'type');
				}
				if (prevSectionProperties?.footerRefs) {
					page.sectProps.footerRefs = _.unionBy(page.sectProps.footerRefs, prevSectionProperties.footerRefs, 'type');
				}
				// cache current sectionProperties as prevSectionProps
				prevSectionProperties = page.sectProps;
			}
		}
		// 一个节可能分好几个页，但是节属性sectionProps存在当前节中最后一段对应的 paragraph 元素的子元素。即：[null,null,null,setPr];
		let currentSectionProperties: SectionProperties = null;
		// 倒序给每一页填充sectionProps，方便后期页面渲染
		for (let i = pages.length - 1; i >= 0; i--) {
			if (pages[i].sectProps == null) {
				pages[i].sectProps = currentSectionProperties;
			} else {
				currentSectionProperties = pages[i].sectProps;
			}
		}

		return pages;
	}

	// 生成所有的页面Page
	async renderPages(document: DocumentElement) {
		// 根据options.breakPages，选择是否分页
		let pages: Page[];
		if (this.options.breakPages) {
			// 根据分页符，初步拆分页面
			pages = this.splitPageBySymbol(document);
		} else {
			// 不分页则，只有一个page
			pages = [new Page({ isSplit: true, sectProps: document.sectProps, children: document.children, } as PageProps)];
		}
		// 初步分页结果,缓存至body中
		document.pages = pages;
		// 前一个节属性，判断分节符的第一个page
		let prevProps = null;
		// 浅拷贝初步分页结果，后续拆分操作将不断扩充数组，导致下面循环异常
		let origin_pages = [...pages];
		// 遍历生成每一个page
		for (let i = 0; i < origin_pages.length; i++) {
			this.currentFootnoteIds = [];
			const page: Page = origin_pages[i];
			const { sectProps } = page;
			// sectionProps属性不存在，则使用文档级别props;
			page.sectProps = sectProps ?? document.sectProps;
			// 是否本小节的第一个page
			page.isFirstPage = prevProps != page.sectProps;
			// TODO 是否最后一个page,此时分页未完成，计算并不准确，影响到尾注的渲染
			page.isLastPage = i === origin_pages.length - 1;
			// 溢出检测默认不开启
			page.checkingOverflow = false;
			// 将上述数据存储在currentPage中
			this.currentPage = page;
			// 存储前一个节属性
			prevProps = page.sectProps;
			// 渲染单个page
			await this.renderPage();
		}
	}

	// 生成单个page，如果发现超出一页，递归拆分出下一个page
	async renderPage() {
		// 解构当前操作的page中的属性
		const { pageId, sectProps, children, isFirstPage, isLastPage } = this.currentPage;
		// 递归建立元素的parent父级关系
		this.processElement(this.currentPage);
		// 根据sectProps，创建page
		const pageElement = this.createPage(this.className, sectProps);

		// 给page添加背景样式
		this.renderStyleValues(
			this.document.documentPart.body.cssStyle,
			pageElement
		);
		// 已拆分的Pages数组
		let pages = this.document.documentPart.body.pages;
		// 计算当前Page的索引
		let pageIndex = pages.findIndex((page) => page.pageId === pageId);
		// 页眉、页脚DOM
		let oHeader: HTMLElement = null;
		let oFooter: HTMLElement = null;
		// 渲染page页眉
		if (this.options.renderHeaders) {
			oHeader = await this.renderHeaderFooterRef(
				sectProps.headerRefs,
				sectProps,
				pageIndex,
				isFirstPage,
				pageElement
			);
		}
		// 渲染page页脚
		if (this.options.renderFooters) {
			oFooter = await this.renderHeaderFooterRef(
				sectProps.footerRefs,
				sectProps,
				pageIndex,
				isFirstPage,
				pageElement
			);
		}
		// TODO 分栏情况下，有可能一个page一种分栏，在分节符（continuous）情况下，一个page拥有多种分栏；

		// page内容区---Article元素
		const contentElement = this.createPageContent(sectProps);
		// get element's offsetHeight, convert to point unit
		let getOffsetHeight = (element: HTMLElement) => {
			let height = element?.offsetHeight ?? 0;
			// convert to point unit
			return height * this.pointToPixelRatio;
		}
		// Header、Footer can affect the page height，it's need to be calculated
		let { pageSize, pageMargins } = sectProps;
		// header height
		let headerHeight = getOffsetHeight(oHeader);
		// footer height
		let footerHeight = getOffsetHeight(oFooter);
		// actual top must be maximum of pageMargins.top and headerHeight
		let actualTop = _.max([parseFloat(pageMargins.top), headerHeight]);
		// actual bottom must be maximum of pageMargins.bottom and footerHeight
		let actualBottom = _.max([parseFloat(pageMargins.bottom), footerHeight]);
		// change pageElement's top and bottom
		pageElement.style.paddingTop = `${actualTop}pt`;
		pageElement.style.paddingBottom = `${actualBottom}pt`;
		// set the contentElement's height based on options.breakPages.
		if (this.options.breakPages) {
			// break pages,set fixed height
			contentElement.style.height = `${parseFloat(pageSize.height) - actualTop - actualBottom}pt`;
		} else {
			// not break pages,set min height
			contentElement.style.minHeight = `${parseFloat(pageSize.height) - actualTop - actualBottom}pt`;
		}
		// 缓存当前操作的Article元素
		this.currentPage.contentElement = contentElement;
		// 将Article插入page
		pageElement.appendChild(contentElement);
		// 标识--开启溢出计算
		this.currentPage.checkingOverflow = true;
		// 生成article内容
		let is_overflow = await this.renderElements(children, contentElement);
		// 元素没有溢出Page
		if (is_overflow === Overflow.FALSE) {
			// 修改当前Page的状态
			this.currentPage.isSplit = true;
			// 替换当前page
			pages[pageIndex] = this.currentPage;
		}
		// 标识--结束溢出计算
		this.currentPage.checkingOverflow = false;
		// TODO 渲染page脚注，不应该插入PageElement中
		if (this.options.renderFootnotes) {
			await this.renderNotes(
				DomType.Footnotes,
				this.currentFootnoteIds,
				this.footnoteMap,
				pageElement
			);
		}
		// TODO 渲染page尾注，判断最后一页，不应该插入PageElement中
		if (this.options.renderEndnotes && isLastPage) {
			await this.renderNotes(
				DomType.Endnotes,
				this.currentEndnoteIds,
				this.endnoteMap,
				pageElement
			);
		}
	}

	// 创建Page
	createPage(className: string, props: SectionProperties) {
		const oPage = createElement('section', { className });

		if (props) {
			// 生成uuid标识，相同的uuid即属于同一个节
			oPage.dataset.sectionId = props.sectionId;
			// 页边距
			if (props.pageMargins) {
				oPage.style.paddingLeft = props.pageMargins.left;
				oPage.style.paddingRight = props.pageMargins.right;
				oPage.style.paddingTop = props.pageMargins.top;
				oPage.style.paddingBottom = props.pageMargins.bottom;
			}
			// 页面尺寸
			if (props.pageSize) {
				if (!this.options.ignoreWidth) {
					oPage.style.width = props.pageSize.width;
				}
				if (!this.options.ignoreHeight) {
					oPage.style.minHeight = props.pageSize.height;
				}
			}
		}
		// 插入生成的page
		this.wrapper.appendChild(oPage);

		return oPage;
	}

	// TODO 分栏：一个页面可能存在多个章节section，每个section拥有不同的分栏
	// 多列分栏布局
	createPageContent(props: SectionProperties): HTMLElement {
		// 指代页面page，HTML5缺少page，以article代替
		const oArticle = createElement('article');
		if (props.columns) {
			const { count, space, separator } = props.columns;
			// 设置多列样式
			if (count > 1) {
				oArticle.style.columnCount = `${count}`;
				oArticle.style.columnGap = space;
			}
			// 分隔符，则添加分割线样式
			if (separator) {
				oArticle.style.columnRule = '1px solid black';
			}
		}

		return oArticle;
	}

	// TODO 分页不准确，页脚页码混乱，
	// TODO 支持奇数页偶数页不同页眉页脚
	// 渲染页眉/页脚的Ref
	async renderHeaderFooterRef(refs: FooterHeaderReference[], props: SectionProperties, pageIndex: number, isFirstPage: boolean, parent: HTMLElement) {
		// Footer/Header References is null
		if (!refs) {
			return null;
		}
		// find Header/Footer Reference
		let ref: FooterHeaderReference;
		// title page
		if (props.titlePage && isFirstPage) {
			// 第一页
			ref = refs.find(x => x.type == "first");
		}
		// 	Different Even/Odd Page Headers and Footers
		else if (this.document.settingsPart.settings.evenAndOddHeaders) {
			// By default,pageIndex start from number 1 in Word document, but pageIndex start from number 0 in Array.
			// fix the above difference
			pageIndex += 1;

			if (pageIndex % 2 === 0) {
				// even page
				ref = refs.find(x => x.type === "even");
			} else {
				// odd page
				ref = refs.find(x => x.type === "default" || x.type === "odd");
			}
		} else {
			// default reference
			ref = refs.find(x => x.type === "default");
		}
		// reference is not found
		if (!ref) {
			console.error("Header/Footer reference is not found");
			return null;
		}
		// find the "part" corresponding to the "ref"：查找ref对应的part部分
		let part = this.document.findPartByRelId(ref?.id, this.document.documentPart) as BaseHeaderFooterPart;
		// part is not found
		if (!part) {
			console.error(`Part corresponding to the reference with id:${ref?.id} is not found`);
			return null;
		}
		// cache current part
		this.currentPart = part;
		// check if the part has been used
		let isUsed = this.usedHeaderFooterParts.includes(part.path);
		if (isUsed === false) {
			// 递归建立元素的parent父级关系
			this.processElement(part.rootElement);
			this.usedHeaderFooterParts.push(part.path);
		}
		// Header or Footer Element
		let oElement: HTMLElement = null;
		// 根据页眉页脚，设置CSS
		switch (part.rootElement.type) {
			case DomType.Header:
				part.rootElement.cssStyle = {
					left: props.pageMargins?.left,
					'padding-top': props.pageMargins.header,
					width: props.contentSize?.width,
				};
				// 渲染header元素
				oElement = await this.renderHeaderFooter(part.rootElement, 'header', parent);
				break;
			case DomType.Footer:
				part.rootElement.cssStyle = {
					left: props.pageMargins?.left,
					'padding-bottom': props.pageMargins.footer,
					width: props.contentSize?.width,
				};
				// 渲染footer元素
				oElement = await this.renderHeaderFooter(part.rootElement, 'footer', parent);
				break;
			default:
				console.warn('set header/footer style error', part.rootElement.type);
				break;
		}
		// 清空当前Part
		this.currentPart = null;

		return oElement;
	}

	// TODO 字体太大，尾注位置不对
	// 渲染脚注/尾注
	async renderNotes(type: DomType = DomType.Footnotes, noteIds: string[], notesMap: Record<string, WmlBaseNote>, parent: HTMLElement) {
		// 筛选出这一页的Note元素集合
		const children: WmlBaseNote[] = noteIds.map(id => notesMap[id]).filter(x => x);

		if (children.length > 0) {
			const oList = createElement('ol', null);
			// 生成Notes父级元素
			let notes = type === DomType.Footnotes ? new WmlFootnotes() : new WmlEndnotes();
			// 设置children子元素
			notes.children = children;
			// 递归建立元素的parent父级关系
			this.processElement(notes);
			// 渲染元素
			await this.renderChildren(notes, oList);
			parent.appendChild(oList);
		}
	}

	// 根据XML对象渲染出多元素
	async renderElements(children: OpenXmlElement[], parent: HTMLElement | Element | Text): Promise<Overflow> {
		// 子元素溢出状态的数组
		let overflows: Overflow[] = [];
		// 已拆分的Pages数组
		let pages: Page[] = this.document.documentPart.body.pages;
		// 当前Page
		let { pageId, sectProps, children: current_page_children } = this.currentPage;

		// 计算当前Page的索引
		let pageIndex: number = pages.findIndex((page) => page.pageId === pageId);

		for (let i = 0; i < children.length; i++) {
			const elem = children[i];
			// 标识元素的索引
			elem.index = i;
			// 子元素溢出索引数组
			if (!elem.breakIndex) {
				elem.breakIndex = new Set();
			}
			// 根据XML对象渲染单个元素
			const rendered_element = await this.renderElement(elem, parent);
			// elem元素是否溢出
			let overflow: Overflow = rendered_element?.dataset?.overflow as Overflow ?? Overflow.UNKNOWN;
			// 下一步操作，终止循环/跳过此次遍历，进入下一次遍历
			let action: string;

			switch (overflow) {
				// 元素自身溢出
				case Overflow.SELF:
					// 缓存溢出元素的索引至自身的breakIndex.
					elem.breakIndex.add(0);
					// 缓存溢出元素的索引至父级的breakIndex。
					elem.parent.breakIndex.add(i);
					// 删除溢出元素
					removeElements(rendered_element, parent);
					action = 'break';
					break;

				// 叶子元素溢出
				case Overflow.TRUE:
				// 插入元素children之后，全部child溢出
				case Overflow.FULL:
					// 缓存溢出元素的索引至父级的breakIndex。
					elem.parent.breakIndex.add(i);
					// 删除溢出元素
					if (elem.type !== DomType.Cell) {
						removeElements(rendered_element, parent);
					}
					action = 'break';
					break;

				// 插入元素children之后，一部分child溢出
				case Overflow.PART:
					// 缓存溢出元素的索引至父级的breakIndex。
					elem.parent.breakIndex.add(i);
					action = 'break';
					break;

				// 未溢出
				case Overflow.FALSE:
				// 未执行溢出检测
				case Overflow.UNKNOWN:
				// 忽略溢出检测
				case Overflow.IGNORE:
					action = 'continue';
					break;

				default:
					action = 'continue';
					if (this.options.debug) {
						console.error('unhandled overflow', overflow, elem);
					}
			}
			// TableRow中存在多个td溢出
			if (elem.type === DomType.Cell) {
				action = 'continue';
			}
			// 将elem元素的溢出状态保存至数组
			overflows.push(overflow);
			// 跳过此次遍历，进入下一次遍历，后续代码不执行；
			if (action === 'continue') {
				continue;
			}
			// 顶层元素：溢出，action === break
			if (elem.level === 2) {
				// 根据breakIndex索引，删除后续元素，原始数组保留前面已经渲染的元素
				let next_page_children: OpenXmlElement[] = current_page_children.splice(i);
				// 生成新的page，新Page的sectionProps沿用前一页的sectionProps
				const next_page: Page = new Page({ sectProps, children: next_page_children } as PageProps);
				// 根据breakIndex索引拆分页面
				this.splitElementsByBreakIndex(this.currentPage, next_page);
				// 修改当前Page的状态
				this.currentPage.isSplit = true;
				this.currentPage.checkingOverflow = false;
				// 重新递归建立元素的parent父级关系
				this.processElement(this.currentPage);
				// 缓存当前page至pages
				pages[pageIndex] = this.currentPage;
				// 缓存拆分出去的新page
				pages.splice(pageIndex + 1, 0, next_page);
				// 新Page覆盖current_page的属性
				this.currentPage = next_page;
				// 重启新一个page的渲染
				await this.renderPage();
			}
			// 终止循环
			break;
		}
		/*
		* 推断elem父级元素溢出类型，overflows数组由于上述循环break的影响，后续子元素溢出状态不会存在，可能只有一个值。
		* 推断规则如下：
		* [Overflow.FULL,..., Overflow.TRUE,Overflow.SELF,Overflow.PART]：全部子元素溢出，推断溢出类型为Overflow.FULL;
		* [Overflow.PART,Overflow.PART,Overflow.PART]：所有子元素部分溢出，推断溢出类型为Overflow.PART;
		* [Overflow.FALSE,..., Overflow.TRUE,Overflow.IGNORE]：部分子元素溢出，推断溢出类型为Overflow.PART;
		* [Overflow.FALSE,Overflow.UNKNOWN,Overflow.IGNORE]：所有元素未溢出Overflow.FALSE，推断溢出类型为Overflow.FALSE;
		* [Overflow.UNKNOWN,Overflow.UNKNOWN,Overflow.UNKNOWN]：所有元素未知Overflow.UNKNOWN，推断溢出类型为Overflow.UNKNOWN;
		*
		* 注意，表格中，Row元素推断溢出类型必须遍历所有子元素。
		*/
		// 如果没有子元素或数组为空，则返回FALSE。注意，every遍历空数组返回true。
		if (overflows.length === 0) {
			return Overflow.FALSE;
		}
		// 溢出状态集合
		let overflowStatus: Overflow[] = [Overflow.FULL, Overflow.SELF, Overflow.TRUE, Overflow.PART];
		// 所有子元素部分溢出，推断溢出类型为Overflow.PART;
		let isAllPart: boolean = overflows.every(overflow => overflow === Overflow.PART);
		if (isAllPart) {
			return Overflow.PART;
		}
		// 是否全溢出
		let isFull: boolean = overflows.every(overflow => overflowStatus.includes(overflow));
		if (isFull) {
			return Overflow.FULL;
		}
		// 是否未执行溢出检测
		let isUnknown: boolean = overflows.every(overflow => overflow === Overflow.UNKNOWN);
		if (isUnknown) {
			return Overflow.UNKNOWN;
		}
		// 是否未溢出
		let isFalse: boolean = overflows.every(overflow => [Overflow.FALSE, Overflow.UNKNOWN, Overflow.IGNORE].includes(overflow));
		if (isFalse) {
			return Overflow.FALSE;
		}
		// 是否部分溢出
		let isPart: boolean = overflows.some(overflow => overflowStatus.includes(overflow));
		if (isPart) {
			return Overflow.PART;
		}
		return Overflow.UNKNOWN;
	}

	// 根据breakIndex索引拆分页面
	splitElementsByBreakIndex(current: OpenXmlElement, next: OpenXmlElement) {
		// 遍历下一个页面的元素
		for (let i = 0; i < next?.children.length; i++) {
			let child = next.children[i];
			let { type, breakIndex, children } = child;
			// 尚未渲染，未执行溢出检测的元素，breakIndex = undefined，跳过
			if (!breakIndex) {
				continue;
			}
			// 末端元素，无需拆分，跳过
			if (!children || children?.length === 0) {
				continue;
			}
			// 复制child的元素,后续缓存至current中
			let copy: OpenXmlElement = _.cloneDeepWith(child, (value, key) => {
				if (key === 'parent') {
					return null;
				}
			});
			/*
			* breakIndex索引前面的元素，并未导致溢出，splice切出这些元素，
			* 切出的元素作为children，复制父级属性，生成新的元素，
			* 未溢出的元素，放入current_page中
			* breakIndex索引后面的元素，已经溢出，存在于next_page;
			* */

			/*
			* 未溢出的元素，全体未溢出：breakIndex = []，部分溢出：breakIndex = [1]
			* 根据溢出索引，确定切除的元素数量
			* */
			let count = breakIndex.size > 0 ? [...breakIndex][0] : children.length;

			switch (type) {
				// 如果当前元素是表格Table
				case DomType.Table:
					let table_headers: WmlTableRow[] = [];
					// 查找表格中的table header，可能有多行
					table_headers = children.filter((row: WmlTableRow) => row.isHeader);
					// 切除未溢出的元素,剩余的溢出元素，归属于next
					const unbrokenChildren = children.splice(0, count);
					// change verticalMerge attribute，restart merge region.
					children[0].children.forEach((cell: WmlTableCell) => {
						if (cell.verticalMerge === 'continue') {
							cell.verticalMerge = 'restart'
						}
					});
					/*
					* 仅当table_headers.length在(0,children.length)范围内，在next中填充table header。
					* 注意，用户误操作导致tr全是tableHeader，导致死循环。
					* */
					if (table_headers.length > 0 && table_headers.length < children.length) {
						children.unshift(...table_headers);
					}
					// 未溢出的子元素覆盖copy
					// 注意，必须修改copy,否则影响下一次递归
					copy.children = unbrokenChildren;
					// current指向原来的父级，push未溢出的元素至current
					current.children.push(copy);

					break;

				// 表格Row
				case DomType.Row:
					// 排除table header
					if ((child as WmlTableRow)?.isHeader) {
						continue;
					}
					// 无需拆分，复制Row至current
					current.children.push(copy);

					break;

				// 如果当前元素是表格Cell
				case DomType.Cell:
					/*
					* 切出未溢出的元素,逐个替换current中cell的子元素
					* 剩余的溢出元素，归属于next
					* 注意，必须修改copy,否则影响下一次递归
					* */
					copy.children = children.splice(0, count);
					current.children[i] = copy;

					break;

				case DomType.Paragraph:
					// 判断是否拆分段落
					let isSplitParagraph = isSplit(child);
					/*
					* 切出未溢出的元素
					* 剩余的溢出元素，归属于next
					* 注意，必须修改copy,否则影响下一次递归
					* */
					copy.children = children.splice(0, count);
					// current指向原来的父级，push未溢出的元素至current
					current.children.push(copy);
					// 段落拆分之后，下一页段落，重设缩进为0
					if (isSplitParagraph) {
						child.cssStyle['text-indent'] = '0'
					}
					break;

				default:
					/*
					* 切出未溢出的元素
					* 剩余的溢出元素，归属于next
					* 注意，必须修改copy,否则影响下一次递归
					* */
					copy.children = children.splice(0, count);
					// current指向原来的父级，push未溢出的元素至current
					current.children.push(copy);
			}
			// 重置breakIndex
			if (type !== DomType.Row && breakIndex.size > 0) {
				child.breakIndex = undefined;
			}
			// 递归调用，继续拆分
			if (children.length > 0) {
				this.splitElementsByBreakIndex(copy, child);
			}
		}

		// 判断是否拆分段落--递归
		function isSplit(elem: OpenXmlElement) {
			let { breakIndex, children, type } = elem;
			// 尚未渲染，未执行溢出检测的元素，breakIndex = undefined，跳过
			if (!breakIndex) {
				return false;
			}
			// 末端元素，无需拆分，跳过
			if (!children || children?.length === 0) {
				return false;
			}
			let i = [...breakIndex][0];
			// 第一个元素溢出，其子元素需递归校验是否拆分段落
			if (i === 0) {
				return isSplit(children[i]);
			}
			// 溢出索引小于children长度，说明溢出
			if (i < children.length) {
				return true;
			}
		}
	}

	// 根据XML对象渲染单个元素
	async renderElement(elem: OpenXmlElement, parent?: HTMLElement | Element | Text): Promise<Node_DOM> {
		let oNode;

		switch (elem.type) {
			case DomType.Paragraph:
				oNode = await this.renderParagraph(elem as WmlParagraph, parent as HTMLElement);
				break;

			case DomType.Run:
				oNode = await this.renderRun(elem as WmlRun, parent as HTMLElement);
				break;

			case DomType.Text:
				oNode = await this.renderText(elem as WmlText, parent as HTMLElement);
				break;

			case DomType.Character:
				oNode = await this.renderCharacter(elem as WmlCharacter, parent as Text);
				break;

			case DomType.Table:
				oNode = await this.renderTable(elem as WmlTable, parent as HTMLElement);
				break;

			case DomType.Row:
				oNode = await this.renderTableRow(elem as WmlTableRow, parent as HTMLElement);
				break;

			case DomType.Cell:
				oNode = await this.renderTableCell(elem as WmlTableCell, parent as HTMLElement);
				break;

			case DomType.Hyperlink:
				oNode = await this.renderHyperlink(elem, parent as HTMLElement);
				break;

			case DomType.Drawing:
				oNode = await this.renderDrawing(elem as WmlDrawing, parent as HTMLElement);
				break;

			case DomType.Image:
				oNode = await this.renderImage(elem as WmlImage, parent as HTMLElement);
				break;

			case DomType.BookmarkStart:
				oNode = this.renderBookmarkStart(elem as WmlBookmarkStart, parent as HTMLElement);
				break;

			case DomType.BookmarkEnd:
				//ignore bookmark end
				oNode = null;
				break;

			case DomType.Tab:
				oNode = await this.renderTab(elem, parent as HTMLElement);
				break;

			case DomType.Symbol:
				oNode = await this.renderSymbol(elem as WmlSymbol, parent as HTMLElement);
				break;

			case DomType.Break:
				oNode = await this.renderBreak(elem as WmlBreak, parent as HTMLElement);
				break;

			case DomType.LastRenderedPageBreak:
				oNode = await this.renderLastRenderedPageBreak(elem as WmlLastRenderedPageBreak, parent as HTMLElement);
				break;

			case DomType.SectionBreak:
				oNode = await this.renderSectionBreak(elem as WmlSectionBreak, parent as HTMLElement);
				break;

			case DomType.Inserted:
				oNode = await this.renderInserted(elem, parent as HTMLElement);
				break;

			case DomType.Deleted:
				oNode = await this.renderDeleted(elem, parent as HTMLElement);
				break;

			case DomType.DeletedText:
				oNode = await this.renderDeletedText(elem as WmlText, parent as HTMLElement);
				break;

			case DomType.NoBreakHyphen:
				oNode = createElement('wbr');
				if (parent) {
					await this.appendChildren(parent as HTMLElement, oNode);
				}
				break;

			case DomType.CommentRangeStart:
				oNode = this.renderCommentRangeStart(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.CommentRangeEnd:
				oNode = this.renderCommentRangeEnd(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.CommentReference:
				oNode = this.renderCommentReference(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.Footer:
				oNode = await this.renderHeaderFooter(elem, 'footer', parent as HTMLElement);
				break;

			case DomType.Header:
				oNode = await this.renderHeaderFooter(elem, 'header', parent as HTMLElement);
				break;

			case DomType.Footnote:
			case DomType.Endnote:
				oNode = await this.renderContainer(elem, 'li');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.FootnoteReference:
				oNode = this.renderFootnoteReference(elem as WmlNoteReference);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.EndnoteReference:
				oNode = this.renderEndnoteReference(elem as WmlNoteReference);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.VmlElement:
				oNode = await this.renderVmlElement(elem as VmlElement, parent as HTMLElement);
				break;

			case DomType.VmlPicture:
				oNode = await this.renderVmlPicture(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlMath:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'math', {
					xmlns: ns.mathML,
				});
				// TODO 作为子元素插入,针对此元素进行溢出检测
				if (parent) {
					oNode.dataset.overflow = await this.appendChildren(parent as HTMLElement, oNode);
				}
				break;

			case DomType.MmlMathParagraph:
				oNode = await this.renderContainer(elem, 'span');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlFraction:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'mfrac');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlBase:
				oNode = await this.renderContainerNS(elem, ns.mathML, elem.parent.type == DomType.MmlMatrixRow ? "mtd" : "mrow");
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlNumerator:
			case DomType.MmlDenominator:
			case DomType.MmlFunction:
			case DomType.MmlLimit:
			case DomType.MmlBox:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'mrow');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlGroupChar:
				oNode = await this.renderMmlGroupChar(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlLimitLower:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'munder');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlMatrix:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'mtable');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlMatrixRow:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'mtr');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlRadical:
				oNode = await this.renderMmlRadical(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlSuperscript:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'msup');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlSubscript:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'msub');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlDegree:
			case DomType.MmlSuperArgument:
			case DomType.MmlSubArgument:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'mn');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlFunctionName:
				oNode = await this.renderContainerNS(elem, ns.mathML, 'ms');
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlDelimiter:
				oNode = await this.renderMmlDelimiter(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlRun:
				oNode = await this.renderMmlRun(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlNary:
				oNode = await this.renderMmlNary(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlPreSubSuper:
				oNode = await this.renderMmlPreSubSuper(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlBar:
				oNode = await this.renderMmlBar(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;

			case DomType.MmlEquationArray:
				oNode = await this.renderMllList(elem);
				// 作为子元素插入,忽略溢出检测
				if (parent) {
					appendChildren(parent, oNode);
				}
				break;
		}
		// 标记其XML标签名
		if (oNode && oNode?.nodeType === 1) {
			oNode.dataset.tag = elem.type;
		}

		return oNode;
	}

	// 根据XML对象渲染子元素，并插入父级元素
	async renderChildren(elem: OpenXmlElement, parent: HTMLElement | Element | Text): Promise<Overflow> {
		return await this.renderElements(elem.children, parent);
	}

	// 插入子元素，针对后代元素进行溢出检测
	async appendChildren(parent: HTMLElement | Text, children: ChildrenType): Promise<Overflow> {
		// 插入元素
		appendChildren(parent, children);

		let { isSplit, contentElement, checkingOverflow, } = this.currentPage;
		// 当前page已拆分，忽略溢出检测
		if (isSplit) {
			return Overflow.UNKNOWN;
		}
		// 当前page未拆分，是否需要溢出检测
		if (checkingOverflow) {
			// 溢出检测
			let isOverflow = checkOverflow(contentElement);
			return isOverflow ? Overflow.TRUE : Overflow.FALSE;
		} else {
			return Overflow.UNKNOWN;
		}
	}

	async renderContainer(elem: OpenXmlElement, tagName: keyof HTMLElementTagNameMap, props?: Record<string, any>) {
		const oContainer = createElement(tagName, props);

		oContainer.dataset.overflow = await this.renderChildren(elem, oContainer);
		return oContainer;
	}

	async renderContainerNS(elem: OpenXmlElement, ns: string, tagName: string, props?: Record<string, any>) {
		const parent = createElementNS(ns, tagName as any, props);
		await this.renderChildren(elem, parent);
		return parent;
	}

	async renderParagraph(elem: WmlParagraph, parent: HTMLElement) {
		// 创建段落元素
		const oParagraph = createElement('p');
		// 生成段落的uuid标识，
		oParagraph.dataset.uuid = elem.uuid;
		// 渲染class
		this.renderClass(elem, oParagraph);
		// 结合文档网格线属性，计算行高
		Object.assign(elem.cssStyle, parseLineSpacing(elem.props, this.currentPage.sectProps))
		// 渲染CSS内联style样式
		this.renderStyleValues(elem.cssStyle, oParagraph);
		// 渲染常规--字体、颜色
		this.renderCommonProperties(oParagraph.style, elem.props);
		// 查找内置style样式
		const style = this.findStyle(elem.styleName);
		// 合并制表位规则
		elem.props.tabs = _.unionBy(elem.props.tabs, style?.paragraphProps?.tabs, 'position');
		// 列表序号
		const numbering = elem.props.numbering ?? style?.paragraphProps?.numbering;

		if (numbering) {
			oParagraph.classList.add(
				this.numberingClass(numbering.id, numbering.level)
			);
		}

		// TODO 子代元素（Run）=> 孙代元素（Drawing）,可能有n个drawML对象。目前仅考虑一个DrawML的情况，多个DrawML对象定位存在bug
		// 是否需要清除浮动
		const is_clear = elem.children.some(run => {
			// 是否存在上下型环绕
			const is_exist_drawML = run?.children?.some(
				child => child.type === DomType.Drawing && child.props.wrapType === WrapType.TopAndBottom
			);
			// 是否存在br元素拥有clear属性
			const is_clear_break = run?.children?.some(
				child => child.type === DomType.Break && child?.props?.clear
			);
			return is_exist_drawML || is_clear_break;
		});
		// 仅在上下型环绕清除浮动
		if (is_clear) {
			oParagraph.classList.add('clearfix');
		}
		// 后代元素定位参照物
		oParagraph.style.position = 'relative';

		// 溢出标识
		let is_overflow: Overflow;
		// oParagraph作为子元素插入,针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oParagraph);
		if (is_overflow === Overflow.TRUE) {
			oParagraph.dataset.overflow = Overflow.SELF;

			return oParagraph;
		}
		// 针对oParagraph后代子元素进行溢出检测
		oParagraph.dataset.overflow = await this.renderChildren(elem, oParagraph);

		return oParagraph;
	}

	async renderRun(elem: WmlRun, parent: HTMLElement) {
		// TODO fieldRun ???
		if (elem.fieldRun) {
			return null;
		}
		// 创建元素
		const oSpan = createElement('span');
		// 渲染class
		this.renderClass(elem, oSpan);
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oSpan);
		// 溢出标识
		let is_overflow: Overflow;
		// 作为子元素插入，先执行溢出检测，方便对后代元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oSpan);
		if (is_overflow === Overflow.TRUE) {
			oSpan.dataset.overflow = Overflow.SELF;

			return oSpan;
		}
		// 上标、下标
		if (elem.verticalAlign) {
			// 创建sup/sub标签
			const oScript = createElement(elem.verticalAlign as any);
			// 将标签插入span，忽略溢出检测。
			appendChildren(oSpan, oScript);
			// 针对后代子元素进行溢出检测
			oSpan.dataset.overflow = await this.renderChildren(elem, oScript);

			return oSpan;
		}
		// 针对后代子元素进行溢出检测
		oSpan.dataset.overflow = await this.renderChildren(elem, oSpan);

		return oSpan;
	}

	async renderText(elem: WmlText, parent: HTMLElement) {
		// String Data
		let oText = document.createTextNode('') as Node_DOM;
		// 初始化dataset对象
		oText.dataset = { overflow: Overflow.UNKNOWN };
		// 作为子元素插入，无需溢出检测
		appendChildren(parent, oText);
		// current page
		let { isSplit } = this.currentPage;
		// 当前page已拆分，忽略溢出检测
		if (isSplit) {
			oText.appendData(elem.text);
			return oText;
		}
		// 针对后代子元素进行溢出检测
		oText.dataset.overflow = await this.renderChildren(elem, oText);

		return oText;
	}

	// 按照单个文字渲染，检测溢出
	async renderCharacter(elem: WmlCharacter, parent: Text) {
		// String Data
		let oCharacter = document.createTextNode(elem.char) as Node_DOM;
		// 初始化dataset对象
		oCharacter.dataset = { overflow: Overflow.UNKNOWN };
		// 作为子元素插入，先执行溢出检测，方便对后代元素进行溢出检测
		oCharacter.dataset.overflow = await this.appendChildren(parent, oCharacter);

		return oCharacter;
	}

	async renderTable(elem: WmlTable, parent: HTMLElement) {
		const oTable = createElement('table');
		// 生成表格的uuid标识，
		oTable.dataset.uuid = uuid();
		// 表格行列位置集合，用于嵌套表格
		this.tableCellPositions.push(this.currentCellPosition);
		// 表格垂直合并集合，用于嵌套表格
		this.tableVerticalMerges.push(this.currentVerticalMerge);
		// 当前Table的垂直合并
		this.currentVerticalMerge = {};
		// 当前Table的行列位置
		this.currentCellPosition = { col: 0, row: 0 };
		// 渲染class
		this.renderClass(elem, oTable);
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oTable);
		// 溢出标识
		let is_overflow: Overflow;
		// oTable作为子元素插入,针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oTable);
		if (is_overflow === Overflow.TRUE) {
			oTable.dataset.overflow = Overflow.SELF;

			return oTable;
		}
		// 渲染表格column列
		if (elem.columns) {
			this.renderTableColumns(elem.columns, oTable);
		}
		// 针对后代子元素进行溢出检测
		oTable.dataset.overflow = await this.renderChildren(elem, oTable);

		// 处理完当前的表格，移除
		this.currentVerticalMerge = this.tableVerticalMerges.pop();
		// 处理完当前的表格，移除
		this.currentCellPosition = this.tableCellPositions.pop();

		return oTable;
	}

	// 表格--列
	renderTableColumns(columns: WmlTableColumn[], parent: HTMLElement) {
		const oColGroup = createElement('colgroup');

		// 插入oColGroup元素,忽略溢出检测
		appendChildren(parent, oColGroup);

		for (const col of columns) {
			const oCol = createElement('col');

			if (col.width) {
				oCol.style.width = col.width;
			}
			// 插入子元素,忽略溢出检测
			appendChildren(oColGroup, oCol);
		}

		return oColGroup;
	}

	// 表格--行
	async renderTableRow(elem: OpenXmlElement, parent: HTMLElement) {
		// 创建元素
		const oTableRow = createElement('tr');
		// 初始化列位置为0
		this.currentCellPosition.col = 0;
		// 渲染class
		this.renderClass(elem, oTableRow);
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oTableRow);
		// 溢出标识
		let is_overflow: Overflow;
		// 作为子元素插入,针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oTableRow);
		if (is_overflow === Overflow.TRUE) {
			oTableRow.dataset.overflow = Overflow.SELF;

			return oTableRow;
		}
		// 针对后代子元素进行溢出检测
		oTableRow.dataset.overflow = await this.renderChildren(elem, oTableRow);
		// 行位置+1
		this.currentCellPosition.row++;

		return oTableRow;
	}

	// 表格--单元格
	async renderTableCell(elem: WmlTableCell, parent: HTMLElement) {
		// create td element which has default attribute colSpan = 1,rowSpan = 1
		const oTableCell = createElement('td');
		// 获取当前cell的列位置
		const key = this.currentCellPosition.col;
		// 当前单元格是否合并
		if (elem.verticalMerge) {
			// Start/Restart Merged Region.
			if (elem.verticalMerge == 'restart') {
				this.currentVerticalMerge[key] = oTableCell;
				oTableCell.rowSpan = 1;
			} else if (this.currentVerticalMerge[key]) {
				// Continue Merged Region.
				this.currentVerticalMerge[key].rowSpan += 1;
				oTableCell.style.display = 'none';
			}
		} else {
			this.currentVerticalMerge[key] = null;
		}
		// 渲染class
		this.renderClass(elem, oTableCell);
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oTableCell);
		// 根据span属性设置列合并
		if (elem.span) {
			oTableCell.colSpan = elem.span;
		}
		// 递增当前cell的列位置
		this.currentCellPosition.col += oTableCell.colSpan;
		// 溢出标识
		let is_overflow: Overflow;
		// oTableCell作为子元素插入，先执行溢出检测，方便对后代元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oTableCell);
		if (is_overflow === Overflow.TRUE) {
			oTableCell.dataset.overflow = Overflow.SELF;

			return oTableCell;
		}
		// 针对后代子元素进行溢出检测
		oTableCell.dataset.overflow = await this.renderChildren(elem, oTableCell);

		return oTableCell;
	}

	async renderHyperlink(elem: WmlHyperlink, parent: HTMLElement) {
		const oAnchor = createElement('a');
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oAnchor);
		// 溢出标识
		let is_overflow: Overflow;
		// 作为子元素插入，先执行溢出检测，方便对后代元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oAnchor);
		if (is_overflow === Overflow.TRUE) {
			oAnchor.dataset.overflow = Overflow.SELF;

			return oAnchor;
		}
		// 链接地址
		if (elem.href) {
			oAnchor.href = elem.href;
		} else if (elem.id) {
			const rel = this.document.documentPart.rels.find(
				it => it.id == elem.id && it.targetMode === 'External'
			);
			oAnchor.href = rel?.target;
		}
		// 针对后代子元素进行溢出检测
		oAnchor.dataset.overflow = await this.renderChildren(elem, oAnchor);

		return oAnchor;
	}

	async renderDrawing(elem: WmlDrawing, parent: HTMLElement) {
		const oDrawing = createElement('span');

		oDrawing.style.textIndent = '0px';

		// TODO 外围添加一个元素清除浮动

		// TODO 标识当前环绕方式，后期可删除
		oDrawing.dataset.wrap = elem?.props.wrapType;
		// 渲染style
		this.renderStyleValues(elem.cssStyle, oDrawing);
		// 溢出标识
		let is_overflow: Overflow;
		// 作为子元素插入，先执行溢出检测，方便对后代元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oDrawing);
		if (is_overflow === Overflow.TRUE) {
			oDrawing.dataset.overflow = Overflow.SELF;

			return oDrawing;
		}
		// 对后代元素进行溢出检测
		oDrawing.dataset.overflow = await this.renderChildren(elem, oDrawing);

		return oDrawing;
	}

	// 渲染图片，默认转换blob--异步
	async renderImage(elem: WmlImage, parent: HTMLElement) {
		// 判断是否需要canvas转换
		const { is_clip, is_transform } = elem.props;
		// Image元素
		const oImage = new Image();
		// 渲染style样式
		this.renderStyleValues(elem.cssStyle, oImage);
		// TODO CMYK的图片丢失，错误转换为RGB
		// TODO 处理emf图片格式
		// 图片资源地址，base64/blob类型
		const source: string = await this.document.loadDocumentImage(
			elem.src,
			this.currentPart
		);
		if (is_clip || is_transform) {
			try {
				// canvas转换
				oImage.src = await this.transformImage(elem, source);
			} catch (e) {
				console.error(`transform ${elem.src} image error:`, e);
			}
		} else {
			// 直接使用原图片
			oImage.src = source;
		}
		// 作为子元素插入，执行溢出检测
		oImage.dataset.overflow = await this.appendChildren(parent, oImage);

		return oImage;
	}

	// 生成Konva框架--元素
	renderKonva() {
		// 创建konva容器元素
		const oContainer = createElement('div');
		oContainer.id = 'konva-container';
		// 插入页面底部
		appendChildren(this.bodyContainer, oContainer);
		// 创建Stage元素
		this.konva_stage = new Konva.Stage({ container: 'konva-container' });
		// 创建Layer元素
		this.konva_layer = new Konva.Layer({ listening: false });
		// 添加Stage元素
		this.konva_stage.add(this.konva_layer);
		// 渲染初始化，显示Stage
		this.konva_stage.visible(true);
	}

	// canvas画布转换，处理旋转、裁剪、翻转等情况
	async transformImage(elem: WmlImage, source: string): Promise<string> {
		const { is_clip, clip, is_transform, transform } = elem.props;
		// 图片实例
		const img = new Image();
		// 设置图片源
		img.src = source;
		// 等待图片解码
		await img.decode();
		// 图片原始尺寸
		const { naturalWidth, naturalHeight } = img;
		// 设置Stage宽高
		this.konva_stage.width(naturalWidth);
		this.konva_stage.height(naturalHeight);
		// 设置Layer配置
		this.konva_layer.removeChildren();
		// 创建Group元素
		const group: Group = new Konva.Group();
		// 图片加载成功后创建Image
		const image = new Konva.Image({
			image: img,
			x: naturalWidth / 2,
			y: naturalHeight / 2,
			width: naturalWidth,
			height: naturalHeight,
			// 旋转中心
			offset: {
				x: naturalWidth / 2,
				y: naturalHeight / 2,
			},
		});
		// 计算裁剪参数
		if (is_clip) {
			const { left, right, top, bottom } = clip.path;
			const x = naturalWidth * left;
			const y = naturalHeight * top;
			const width = naturalWidth * (1 - left - right);
			const height = naturalHeight * (1 - top - bottom);
			image.crop({ x, y, width, height });
			image.size({ width, height });
		}
		// transform变换
		if (is_transform) {
			for (const key in transform) {
				switch (key) {
					case 'scaleX':
						image.scaleX(transform[key]);
						break;
					case 'scaleY':
						image.scaleY(transform[key]);
						break;
					case 'rotate':
						image.rotation(transform[key]);
						break;
				}
			}
		}
		// Group添加Image图片
		group.add(image);
		// 添加Group元素
		this.konva_layer.add(group);
		// 导出装换之后的图片
		let result: string | PromiseLike<string>;
		if (this.options.useBase64URL) {
			result = group.toDataURL();
		} else {
			const blob = (await group.toBlob()) as Blob;
			result = URL.createObjectURL(blob);
		}


		return result;
	}

	// 渲染书签，主要用于定位，导航
	renderBookmarkStart(elem: WmlBookmarkStart, parent: HTMLElement): HTMLElement {
		const oSpan = createElement('span');
		oSpan.id = elem.name;
		// 作为子元素插入
		appendChildren(parent, oSpan);
		// 忽略溢出检测
		oSpan.dataset.overflow = Overflow.IGNORE;

		return oSpan;
	}

	// 渲染制表符
	async renderTab(elem: OpenXmlElement, parent: HTMLElement) {
		const tabSpan = createElement('span');

		tabSpan.innerHTML = '&nbsp;';

		if (this.options.experimental) {
			tabSpan.className = this.tabStopClass();
			const stops = findParent<WmlParagraph>(elem, DomType.Paragraph).props?.tabs;
			this.currentTabs.push({ stops, span: tabSpan });
		}

		// 作为子元素插入，执行溢出检测
		if (parent) {
			await this.appendChildren(parent, tabSpan);
		}

		return tabSpan;
	}

	async renderSymbol(elem: WmlSymbol, parent: HTMLElement) {
		const oSymbol = createElement('span');
		oSymbol.style.fontFamily = elem.font;
		oSymbol.innerHTML = `&#x${elem.char};`;
		// 溢出标识
		let is_overflow: Overflow;
		// oSymbol作为子元素插入，针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oSymbol);

		if (is_overflow === Overflow.TRUE) {
			oSymbol.dataset.overflow = Overflow.SELF;
		}

		oSymbol.dataset.overflow = is_overflow;

		return oSymbol;
	}

	// 渲染换行符号
	async renderBreak(elem: WmlBreak, parent: HTMLElement) {
		let oBreak: HTMLElement;

		switch (elem.break) {
			// 分页符
			case BreakType.Page:
				oBreak = createElement('br');
				// 添加class
				oBreak.classList.add('break', 'page');
				break;

			// 	TODO 分栏符
			case BreakType.Column:
				oBreak = createElement('br');
				// 添加class
				oBreak.classList.add('break', 'column');
				break;

			// 强制换行
			case BreakType.TextWrapping:
			default:
				oBreak = createElement('br');
				// 添加class
				oBreak.classList.add('break', 'textWrap');
				break;
		}
		// oBreak作为子元素插入，针对此元素执行溢出检测
		let isOverflow = await this.appendChildren(parent, oBreak);

		if (isOverflow === Overflow.TRUE) {
			isOverflow = Overflow.SELF;
		}

		oBreak.dataset.overflow = isOverflow;

		return oBreak;
	}

	async renderLastRenderedPageBreak(elem: WmlLastRenderedPageBreak, parent: HTMLElement) {
		const oLastRenderedPageBreak = createElement('wbr');
		// 添加class
		oLastRenderedPageBreak.classList.add('lastRenderedPageBreak');
		// oLastRenderedPageBreak作为子元素插入，针对此元素执行溢出检测
		let isOverflow = await this.appendChildren(parent, oLastRenderedPageBreak);
		// if true,empty element should be Overflow.SELF
		if (isOverflow === Overflow.TRUE) {
			isOverflow = Overflow.SELF;
		}

		oLastRenderedPageBreak.dataset.overflow = isOverflow;

		return oLastRenderedPageBreak;
	}

	async renderSectionBreak(elem: WmlSectionBreak, parent: HTMLElement) {
		const oSectionBreak = createElement('s');
		// 添加class
		oSectionBreak.classList.add('break', 'section');
		// oSectionBreak作为子元素插入，针对此元素执行溢出检测
		let isOverflow = await this.appendChildren(parent, oSectionBreak);
		// if true,empty element should be Overflow.SELF
		if (isOverflow === Overflow.TRUE) {
			isOverflow = Overflow.SELF;
		}

		oSectionBreak.dataset.overflow = isOverflow;
		// break type
		oSectionBreak.dataset.type = elem.break;

		return oSectionBreak;
	}

	// TODO 修订标识：修订人，修订日期等信息
	// TODO 修订标识：表格
	async renderInserted(elem: OpenXmlElement, parent: HTMLElement) {
		// 根据option，是否渲染修订文本，确定tagName
		let tagName: keyof HTMLElementTagNameMap = this.options.renderChanges ? 'ins' : 'span';
		// 创建元素
		const oInserted: HTMLModElement | HTMLSpanElement = createElement(tagName);
		// 溢出标识
		let is_overflow: Overflow;
		// oInserted作为子元素插入,针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oInserted);
		if (is_overflow === Overflow.TRUE) {
			oInserted.dataset.overflow = Overflow.SELF;

			return oInserted;
		}
		// 针对oInserted后代子元素进行溢出检测
		oInserted.dataset.overflow = await this.renderChildren(elem, oInserted);

		return oInserted;
	}

	// 渲染删除标记
	async renderDeleted(elem: OpenXmlElement, parent: HTMLElement) {
		let oDeleted = createElement('del');
		// 根据option，是否渲染修订文本
		if (this.options.renderChanges === false) {
			// 隐藏修订文本
			oDeleted.style.display = 'none';
		}
		// 溢出标识
		let is_overflow: Overflow;
		// oDeleted作为子元素插入,针对此元素进行溢出检测
		is_overflow = await this.appendChildren(parent, oDeleted);

		if (is_overflow === Overflow.TRUE) {
			oDeleted.dataset.overflow = Overflow.SELF;

			return oDeleted;
		}
		// 针对oDeleted后代子元素进行溢出检测
		oDeleted.dataset.overflow = await this.renderChildren(elem, oDeleted);

		return oDeleted;
	}

	// 渲染删除文本
	async renderDeletedText(elem: WmlText, parent: HTMLElement) {
		// 根据option，是否渲染修订文本
		if (this.options.renderChanges === false) {
			// 隐藏修订文本
		}
		return this.renderText(elem, parent);
	}

	// 注释开始
	renderCommentRangeStart(commentStart: WmlCommentRangeStart) {
		if (!this.options.experimental) {
			return null;
		}

		return document.createComment(`start of comment #${commentStart.id}`);
	}

	// 注释结束
	renderCommentRangeEnd(commentEnd: WmlCommentRangeStart) {
		if (!this.options.experimental) {
			return null;
		}

		return document.createComment(`end of comment #${commentEnd.id}`);
	}

	// 注释
	renderCommentReference(commentRef: WmlCommentReference) {
		if (!this.options.experimental) {
			return null;
		}

		const comment = this.document.commentsPart?.commentMap[commentRef.id];

		if (!comment) return null;

		return document.createComment(
			`comment #${comment.id} by ${comment.author} on ${comment.date}`
		);
	}

	// 渲染页眉页脚
	async renderHeaderFooter(elem: OpenXmlElement, tagName: keyof HTMLElementTagNameMap, parent: HTMLElement) {
		const oElement: HTMLElement = createElement(tagName);
		// 插入元素，忽略溢出监测
		appendChildren(parent, oElement);
		// 渲染style样式
		this.renderStyleValues(elem.cssStyle, oElement);
		// 渲染子元素
		await this.renderChildren(elem, oElement);

		return oElement;
	}

	// 渲染脚注
	renderFootnoteReference(elem: WmlNoteReference) {
		const oSup = createElement('sup');
		this.currentFootnoteIds.push(elem.id);
		oSup.textContent = `${this.currentFootnoteIds.length}`;
		return oSup;
	}

	// 渲染尾注
	renderEndnoteReference(elem: WmlNoteReference) {
		const oSup = createElement('sup');
		this.currentEndnoteIds.push(elem.id);
		oSup.textContent = `${this.currentEndnoteIds.length}`;
		return oSup;
	}

	async renderVmlElement(elem: VmlElement, parent?: HTMLElement): Promise<SVGElement> {
		const oSvg = createSvgElement('svg');

		oSvg.setAttribute('style', elem.cssStyleText);

		const oChildren = await this.renderVmlChildElement(elem);

		if (elem.imageHref?.id) {
			const source = await this.document?.loadDocumentImage(elem.imageHref.id, this.currentPart);
			oChildren.setAttribute('href', source);
		}
		// 后代元素忽略溢出检测
		appendChildren(oSvg, oChildren);

		requestAnimationFrame(() => {
			const bb = (oSvg.firstElementChild as any).getBBox();

			oSvg.setAttribute('width', `${Math.ceil(bb.x + bb.width)}`);
			oSvg.setAttribute('height', `${Math.ceil(bb.y + bb.height)}`);
		});
		// 如果拥有父级
		if (parent) {
			// 作为子元素插入,针对此元素进行溢出检测
			oSvg.dataset.overflow = await this.appendChildren(parent, oSvg);
		}
		return oSvg;
	}

	// 渲染VML中图片
	async renderVmlPicture(elem: OpenXmlElement) {
		const oPictureContainer = createElement('span');
		await this.renderChildren(elem, oPictureContainer);
		return oPictureContainer;
	}

	async renderVmlChildElement(elem: VmlElement) {
		const oVMLElement = createSvgElement(elem.tagName as any);
		// set attributes
		Object.entries(elem.attrs).forEach(([k, v]) => oVMLElement.setAttribute(k, v));

		for (const child of elem.children) {
			if (child.type == DomType.VmlElement) {
				const oChild = await this.renderVmlChildElement(child as VmlElement);
				appendChildren(oVMLElement, oChild);
			} else {
				await this.renderElement(child as any, oVMLElement);
			}
		}

		return oVMLElement;
	}

	async renderMmlRadical(elem: OpenXmlElement) {
		const base = elem.children.find(el => el.type == DomType.MmlBase);
		let oParent: MathMLElement;
		if (elem.props?.hideDegree) {
			oParent = createElementNS(ns.mathML, 'msqrt', null);
			await this.renderElements([base], oParent);
			return oParent;
		}

		const degree = elem.children.find(el => el.type == DomType.MmlDegree);
		oParent = createElementNS(ns.mathML, 'mroot', null);
		await this.renderElements([base, degree], oParent);
		return oParent;
	}

	async renderMmlDelimiter(elem: OpenXmlElement): Promise<MathMLElement> {
		const oMrow: MathMLElement = createElementNS(ns.mathML, 'mrow', null);
		// 开始Char
		let oBegin: MathMLElement = createElementNS(ns.mathML, "mo", null, [elem.props.beginChar ?? '(']);
		appendChildren(oMrow, oBegin);
		// 子元素
		await this.renderElements(elem.children, oMrow);
		// 结束char
		let oEnd: MathMLElement = createElementNS(ns.mathML, "mo", null, [elem.props.endChar ?? ')']);
		appendChildren(oMrow, oEnd);

		return oMrow;
	}

	async renderMmlNary(elem: OpenXmlElement): Promise<MathMLElement> {
		const children = [];
		const grouped = _.keyBy(elem.children, 'type');

		const sup = grouped[DomType.MmlSuperArgument];
		const sub = grouped[DomType.MmlSubArgument];

		let supElem: MathMLElement = sup ? createElementNS(ns.mathML, "mo", null, asArray(await this.renderElement(sup))) : null;
		let subElem: MathMLElement = sub ? createElementNS(ns.mathML, "mo", null, asArray(await this.renderElement(sub))) : null;

		let charElem: MathMLElement = createElementNS(ns.mathML, "mo", null, [elem.props?.char ?? '\u222B']);

		if (supElem || subElem) {
			children.push(createElementNS(ns.mathML, "munderover", null, [charElem, subElem, supElem]));
		} else if (supElem) {
			children.push(createElementNS(ns.mathML, "mover", null, [charElem, supElem]));
		} else if (subElem) {
			children.push(createElementNS(ns.mathML, "munder", null, [charElem, subElem]));
		} else {
			children.push(charElem);
		}

		const oMrow: MathMLElement = createElementNS(ns.mathML, 'mrow', null);

		appendChildren(oMrow, children);

		await this.renderElements(grouped[DomType.MmlBase].children, oMrow);

		return oMrow;
	}

	async renderMmlPreSubSuper(elem: OpenXmlElement) {
		const children = [];
		const grouped = _.keyBy(elem.children, 'type');

		const sup = grouped[DomType.MmlSuperArgument];
		const sub = grouped[DomType.MmlSubArgument];
		let supElem: MathMLElement = sup ? createElementNS(ns.mathML, "mo", null, asArray(await this.renderElement(sup))) : null;
		let subElem: MathMLElement = sub ? createElementNS(ns.mathML, "mo", null, asArray(await this.renderElement(sub))) : null;
		let stubElem: MathMLElement = createElementNS(ns.mathML, "mo", null);

		children.push(createElementNS(ns.mathML, "msubsup", null, [stubElem, subElem, supElem]));

		const oMrow = createElementNS(ns.mathML, 'mrow', null);

		appendChildren(oMrow, children);

		await this.renderElements(grouped[DomType.MmlBase].children, oMrow);

		return oMrow;
	}

	async renderMmlGroupChar(elem: OpenXmlElement) {
		let tagName = elem.props.verticalJustification === "bot" ? "mover" : "munder";
		let oGroupChar = await this.renderContainerNS(elem, ns.mathML, tagName);

		if (elem.props.char) {
			const oMo = createElementNS(ns.mathML, 'mo', null, [elem.props.char]);
			appendChildren(oGroupChar, oMo);
		}

		return oGroupChar;
	}

	async renderMmlBar(elem: OpenXmlElement) {
		let oMrow = await this.renderContainerNS(elem, ns.mathML, "mrow") as MathMLElement;

		switch (elem.props.position) {
			case 'top':
				oMrow.style.textDecoration = 'overline';
				break;
			case 'bottom':
				oMrow.style.textDecoration = 'underline';
				break;
		}

		return oMrow;
	}

	async renderMmlRun(elem: OpenXmlElement) {
		const oMs = createElementNS(ns.mathML, 'ms') as HTMLElement;

		this.renderClass(elem, oMs);
		this.renderStyleValues(elem.cssStyle, oMs);
		await this.renderChildren(elem, oMs);

		return oMs;
	}

	async renderMllList(elem: OpenXmlElement) {
		const oMtable = createElementNS(ns.mathML, 'mtable') as HTMLElement;
		// 添加class类
		this.renderClass(elem, oMtable);
		// 渲染style样式
		this.renderStyleValues(elem.cssStyle, oMtable);

		for (const child of elem.children) {
			const oChild = await this.renderElement(child);

			const oMtd = createElementNS(ns.mathML, 'mtd', null, [oChild]);

			const oMtr = createElementNS(ns.mathML, 'mtr', null, [oMtd]);

			appendChildren(oMtable, oMtr);
		}

		return oMtable;
	}

	// 设置元素style样式
	renderStyleValues(style: Record<string, string>, output: HTMLElement) {
		for (const k in style) {
			if (k.startsWith('$')) {
				output.setAttribute(k.slice(1), style[k]);
			} else {
				output.style[k] = style[k];
			}
		}
	}

	renderRunProperties(style: any, props: RunProperties) {
		this.renderCommonProperties(style, props);
	}

	renderCommonProperties(style: any, props: CommonProperties) {
		if (props == null) return;

		if (props.color) {
			style['color'] = props.color;
		}

		if (props.fontSize) {
			style['font-size'] = props.fontSize;
		}
	}

	// 添加class类名
	renderClass(input: OpenXmlElement, output: HTMLElement | Element) {
		if (input.className) {
			output.className = input.className;
		}

		if (input.styleName) {
			output.classList.add(this.processStyleName(input.styleName));
		}
	}

	// 查找内置默认style样式
	findStyle(styleName: string) {
		return styleName && this.styleMap?.[styleName];
	}

	tabStopClass() {
		return `${this.className}-tab-stop`;
	}

	// 刷新tab制表符
	refreshTabStops() {
		if (!this.options.experimental) {
			return;
		}
		for (const tab of this.currentTabs) {
			updateTabStop(tab.span, tab.stops, this.defaultTabSize, this.pointToPixelRatio);
		}
	}
}

/*
 *  操作DOM元素的函数方法
 */

// 元素类型
type ChildrenType = Node[] | Node | Element[] | Element;

// 根据标签名tagName创建元素
function createElement<T extends keyof HTMLElementTagNameMap>(tagName: T, props?: Partial<Record<keyof HTMLElementTagNameMap[T], any>>): HTMLElementTagNameMap[T] {
	return createElementNS(null, tagName, props);
}

// 根据标签名tagName创建svg元素
function createSvgElement<T extends keyof SVGElementTagNameMap>(tagName: T, props?: Partial<Record<keyof SVGElementTagNameMap[T], any>>): SVGElementTagNameMap[T] {
	return createElementNS(ns.svg, tagName, props);
}

// 根据标签名tagName创建带命名空间的元素
function createElementNS<T extends keyof MathMLElementTagNameMap>(ns: string, tagName: T, props?: Partial<Record<any, any>>, children?: ChildrenType): MathMLElementTagNameMap[T];
function createElementNS<T extends keyof SVGElementTagNameMap>(ns: string, tagName: T, props?: Partial<Record<any, any>>, children?: ChildrenType): SVGElementTagNameMap[T];
function createElementNS<T extends keyof HTMLElementTagNameMap>(ns: string, tagName: T, props?: Partial<Record<any, any>>, children?: ChildrenType): HTMLElementTagNameMap[T];
function createElementNS<T>(ns: string, tagName: T, props?: Partial<Record<any, any>>, children?: ChildrenType): Element | SVGElement | MathMLElement {
	let oParent: Element | SVGElement | MathMLElement;
	switch (ns) {
		case "http://www.w3.org/1998/Math/MathML":
			oParent = document.createElementNS(ns, tagName as keyof MathMLElementTagNameMap);
			break;
		case 'http://www.w3.org/2000/svg':
			oParent = document.createElementNS(ns, tagName as keyof SVGElementTagNameMap);
			break;
		case 'http://www.w3.org/1999/xhtml':
			oParent = document.createElement(tagName as keyof HTMLElementTagNameMap);
			break;
		default:
			oParent = document.createElement(tagName as keyof HTMLElementTagNameMap);
	}

	if (props) {
		Object.assign(oParent, props);
	}

	if (children) {
		appendChildren(oParent, children);
	}

	return oParent;
}

// 清空所有子元素
function removeAllElements(elem: HTMLElement) {
	elem.innerHTML = '';
}

// 插入子元素，忽略溢出检测
function appendChildren(parent: Element | Text, children: ChildrenType): void {
	if (parent instanceof Element) {
		if (Array.isArray(children)) {
			parent.append(...children);
		} else {
			if (_.isString(children)) {
				parent.append(children);
			} else {
				parent.appendChild(children);
			}
		}
	}
	if (parent instanceof Text) {
		if (Array.isArray(children)) {
			throw new Error('Text append children: children must be text node');
		} else {
			if (children instanceof Text) {
				parent.appendData(children.wholeText);
			}
		}
	}
}

// 判断文本区是否溢出
function checkOverflow(el: HTMLElement): boolean {
	// 提取原来的overflow属性值
	const current_overflow: string = getComputedStyle(el).overflow;
	//先让溢出效果为 hidden 这样才可以比较 clientHeight和scrollHeight
	if (!current_overflow || current_overflow === 'visible') {
		el.style.overflow = 'hidden';
	}
	const is_overflow: boolean = el.clientHeight < el.scrollHeight;

	// 还原overflow属性值
	el.style.overflow = current_overflow;

	return is_overflow;
}

// 删除单个或者多个子元素
function removeElements(target: Node[] | Node, parent: HTMLElement | Element | Text): void;
function removeElements(target: Element[] | Element): void;
function removeElements(target: ChildrenType, parent?: HTMLElement | Element | Text): void {
	// parent is optional
	if (parent === undefined) {
		if (Array.isArray(target)) {
			target.forEach(elem => {
				if (elem instanceof Element) {
					elem.remove();
				} else {
					throw new Error('removeElements: target must be Element!');
				}
			});
		} else {
			if (target instanceof Element) {
				target.remove();
			} else {
				throw new Error('removeElements: target must be Element!');
			}
		}
		return;
	}
	// parent is text node
	if (parent instanceof Text) {
		if (Array.isArray(target)) {
			throw new Error('Text remove target: target must be text node!');
		} else {
			if (target instanceof Text) {
				// at this point, deleteData is better than remove, because text was inserted by appendData
				parent.deleteData(parent.length - target.length, target.length);
			}
		}
	}
	if (parent instanceof Element) {
		if (Array.isArray(target)) {
			target.forEach(elem => {
				if (elem instanceof Element) {
					elem.remove();
				} else {
					parent.removeChild(elem);
				}
			});
		} else {
			if (target instanceof Element) {
				target.remove();
			} else {
				parent.removeChild(target);
			}
		}
	}
}

// 创建style标签
function createStyleElement(cssText: string) {
	return createElement('style', { innerHTML: cssText });
}

// 插入注释
function appendComment(elem: HTMLElement, comment: string) {
	elem.appendChild(document.createComment(comment));
}

// 根据元素类型，回溯元素的父级元素、祖先元素
function findParent<T extends OpenXmlElement>(elem: OpenXmlElement, type: DomType): T {
	let parent = elem.parent;

	while (parent != null && parent.type != type) {
		parent = parent.parent;
	}

	return <T>parent;
}
