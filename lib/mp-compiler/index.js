const babel = require('@babel/core')
const path = require('path')
const fs = require('fs')
const deepEqual = require('deep-equal')
const compiler = require('cb-mpvue-template-compiler')

const { parseConfig, parseComponentsDeps, parseGlobalComponents, clearGlobalComponents, parseMixinsDeps } = require('./parse')
const { parseComponentsDeps: parseComponentsDepsTs } = require('./parse-ts')
const { genPageML } = require('./templates')
const { extractScriptFilters, combineScriptAndMixinsFilters } = require('../script-compiler')

const {
  cachePageInfo,
  cacheFileInfo,
  getPageInfo,
  getFileInfo,
  getCompInfo,
  getFiltersOutputSrc,
  resolveTarget,
  covertCCVar,
  cacheSlots,
  getSlots,
  htmlBeautify,
  getBabelrc
} = require('./util')

function genComponentMPML (compiled, options, emitFile, emitError, emitWarning, fileExt) {
  options.components['slots'] = { src: '/components/slots' + '.' + fileExt.template, name: 'slots' }
  const { code: mpmlContent, compiled: compiledResult, slots, importCode } = compiler.compileToMPML(compiled, options, fileExt)
  const { mpErrors, mpTips } = compiledResult
  // 缓存 slots，延迟编译
  cacheSlots(slots, importCode)

  if (mpErrors && mpErrors.length) {
    emitError('\n  Error compiling template:\n' + mpErrors.map(e => ` - ${e}`).join('\n') + '\n')
  }
  if (mpTips && mpTips.length) {
    emitWarning(mpTips.map(e => ` - ${e}`).join('\n') + '\n')
  }
  return htmlBeautify(mpmlContent)
}

function createPageMPML (emitFile, resourcePath, rootComponent, context, fileExt) {
  const { src } = getFileInfo(resourcePath) || {}
  const { name, filePath } = getCompInfo(context, rootComponent, fileExt)
  const MPMLContent = genPageML(name, filePath, fileExt)
  if (fileExt.platform === 'my') {
    cachePageInfo(rootComponent, { pageFilePath: `${src}.${fileExt.template}`, MPMLContent })
  } else {
    emitFile(`${src}.${fileExt.template}`, MPMLContent)
  }
}

// 更新全局组件时，需要重新生成 mpml，用这个字段保存所有需要更新的页面及其参数
const cacheCreateMPMLFns = {}

function createComponentMPML ({ emitWarning, emitError, emitFile, resourcePath, context, compiled, fileExt }) {
  cacheCreateMPMLFns[resourcePath] = arguments
  const { pageType, moduleId, components, filters } = getFileInfo(resourcePath) || {}
  const { name, filePath } = getCompInfo(context, resourcePath, fileExt)
  const options = { components, pageType, name, moduleId, filters }
  const MPMLContent = genComponentMPML(compiled, options, emitFile, emitError, emitWarning, fileExt)
  if (fileExt.platform === 'my') {
    // 支付宝小程序特殊处理
    if (Object.keys(getPageInfo(resourcePath)).length > 0) {
      const { pageFilePath, MPMLContent: pageMPMLContent } = getPageInfo(resourcePath)
      emitFile(pageFilePath, `${MPMLContent}\n${pageMPMLContent}`)
    } else {
      emitFile(filePath, MPMLContent)
    }
  } else {
    emitFile(filePath, MPMLContent)
  }
}

let slotsHookAdded = false
function compileMPML (compiled, html, options) {
  const fileExt = options.fileExt
  if (!slotsHookAdded) {
    // avoid add hook several times during compilation
    slotsHookAdded = true
    // TODO: support webpack4
    this._compilation.plugin('seal', () => {
      const content = getSlots(fileExt)
      if (content.trim()) {
        this.emitFile(`components/slots.${fileExt.template}`, htmlBeautify(content))
      }
      slotsHookAdded = false
    })
  }

  return new Promise(resolve => {
    const pollComponentsStatus = () => {
      const { pageType, components, filters } = getFileInfo(this.resourcePath) || {}
      if (!pageType || (components && !components.isCompleted) || (filters && !filters.isCompleted)) {
        setTimeout(pollComponentsStatus, 20)
      } else {
        resolve()
      }
    }
    pollComponentsStatus()
  }).then(() => {
    createComponentMPML({
      emitWarning: this.emitWarning,
      emitError: this.emitError,
      emitFile: this.emitFile,
      resourcePath: this.resourcePath,
      context: this._compiler.options.context,
      rootComponent: null,
      compiled, html,
      fileExt
    })
  })
}

// 针对 .vue 单文件的脚本逻辑的处理
// 处理出当前单文件组件的子组件依赖
function compileMPScript (script, mpOptioins, moduleId) {
  // enhance: 兼容新版webpack4，options在this._compiler中
  const { resourcePath, _compiler: { options }, resolve, context, emitFile } = this
  const babelrc = getBabelrc(mpOptioins.globalBabelrc)
  let result, metadata
  let scriptContent = script.content
  const babelOptions = { extends: babelrc, plugins: [parseComponentsDeps, parseMixinsDeps] }
  if (script.src) {
    const scriptpath = path.join(path.dirname(resourcePath), script.src)
    scriptContent = fs.readFileSync(scriptpath).toString()
  }
  if (script.lang === 'ts') {
    metadata = parseComponentsDepsTs(scriptContent)
  } else {
    result = babel.transformSync(scriptContent, babelOptions)
    metadata = result.metadata
  }
  // metadata: importsMap, components
  const { importsMap, components: originComponents, mixins } = metadata

  // 处理子组件的信息
  const components = {}
  const fileInfo = resolveTarget(resourcePath, options.entry)

  const callback = () => resolveComponent(resourcePath, fileInfo, importsMap, components, moduleId)
  if (originComponents) {
    resolveSrc(originComponents, components, resolve, context, options.context, mpOptioins.fileExt)
      .then(() => callback())
      .catch(err => {
        console.error(err)
        callback()
      })
  } else {
    callback()
  }

  // 处理filters信息
  const mixinsFilters = []
  if (mixins) {
    // 包含外部mixins引用
    resolveMixinsFilters(mixins, mixinsFilters, resolve, context, options.context, babelOptions, emitFile, mpOptioins.fileExt).then(() => {
      resolveFilters(resourcePath, fileInfo, scriptContent, babelOptions, mixinsFilters, context, options.context, emitFile, mpOptioins.fileExt)
    }).catch(err => {
      console.error(err)
      resolveFilters(resourcePath, fileInfo, scriptContent, babelOptions, mixinsFilters, context, options.context, emitFile, mpOptioins.fileExt)
    })
  } else {
    // 不包外部mixins引用，则直接获取脚本中的filters信息
    resolveFilters(resourcePath, fileInfo, scriptContent, babelOptions, mixinsFilters, context, options.context, emitFile, mpOptioins.fileExt)
  }

  return script
}

// checkMPEntry 针对 entry main.js 的入口处理: 编译出 app, page 的入口js、mpml、json
let globalComponents
function compileMP (content, mpOptioins) {
  // enhance: 兼容新版webpack4，options在this._compiler中
  const { resourcePath, emitFile, resolve, context, _compiler: { options }} = this
  const fileInfo = resolveTarget(resourcePath, options.entry)
  cacheFileInfo(resourcePath, fileInfo)
  const { isApp, isPage } = fileInfo
  if (isApp) {
    // 解析前将可能存在的全局组件清空
    clearGlobalComponents()
  }

  const babelrc = getBabelrc(mpOptioins.globalBabelrc)
  // app入口进行全局component解析
  const { metadata } = babel.transformSync(content, { extends: babelrc, plugins: isApp ? [parseConfig, parseGlobalComponents] : [parseConfig] })

  // metadata: config
  const { rootComponent, globalComponents: globalComps, importsMap } = metadata

  if (isApp) {
    // 保存旧数据，用于对比
    const oldGlobalComponents = globalComponents
    // 开始解析组件路径时把全局组件清空，解析完成后再进行赋值，标志全局组件解析完成
    globalComponents = null

    // 解析全局组件的路径
    const components = {}
    resolveImportSrc(importsMap, globalComps, components, resolve, context, options.context, babelrc, mpOptioins.fileExt).then(() => {
      handleResult(components)
    }).catch(err => {
      console.error(err)
      handleResult(components)
    })
    const handleResult = components => {
      globalComponents = components
      // 热更时，如果全局组件更新，需要重新生成所有的 mpml
      if (oldGlobalComponents && !deepEqual(oldGlobalComponents, globalComponents)) {
        // 更新所有页面的组件
        Object.keys(cacheResolveComponents).forEach(k => {
          resolveComponent(...cacheResolveComponents[k])
        })
        // 重新生成所有 mpml
        Object.keys(cacheCreateMPMLFns).forEach(k => {
          createComponentMPML(...cacheCreateMPMLFns[k])
        })
      }
    }
  }

  if (isApp || isPage) {
    // 这儿应该异步在所有的模块都清晰后再生成
    // 生成入口 mpml
    if (isPage && rootComponent) {
      resolve(context, rootComponent, (err, rootComponentSrc) => {
        if (err) return
        // 这儿需要搞定 根组件的 路径
        // enhance: 兼容新版webpack4，options在this._compiler中
        createPageMPML(emitFile, resourcePath, rootComponentSrc, this._compiler.options.context, mpOptioins.fileExt)
      })
    }
  }

  return content
}

function resolveImportSrc (importsMap, globalComps, components, resolveFn, context, projectRoot, babelrc, fileExt) {
  return Promise.all(Object.keys(importsMap).map(k => {
    return new Promise((resolve, reject) => {
      resolveFn(context, importsMap[k], (err, realSrc) => {
        if (err) return reject(err)
        const importFileSource = fs.readFileSync(realSrc).toString()
        let babelResult
        try {
          babelResult = babel.transformSync(importFileSource, { extends: babelrc, plugins: parseGlobalComponents })
        } catch (e) {}
        if (babelResult) {
          const { metadata } = babelResult
          const { globalComponents } = metadata
          if (globalComponents && Object.keys(globalComponents).length > 0) {
            Object.keys(globalComponents).map(key => {
              if (!globalComps[key]) {
                globalComps[key] = globalComponents[key]
              }
            })
          }
        }
        resolve()
      })
    })
  })).then(() => {
    return resolveSrc(globalComps, components, resolveFn, context, projectRoot, fileExt)
  })
}

function resolveSrc (originComponents, components, resolveFn, context, projectRoot, fileExt) {
  return Promise.all(Object.keys(originComponents).map(k => {
    return new Promise((resolve, reject) => {
      resolveFn(context, originComponents[k], (err, realSrc) => {
        if (err) return reject(err)
        const com = covertCCVar(k)
        let { filePath, name } = getCompInfo(projectRoot, realSrc, fileExt)
        if (fileExt.platform === 'my' && (Object.keys(getPageInfo(realSrc)).length > 0)) {
          // 支付宝小程序特殊处理
          filePath = filePath.replace('.' + fileExt.template, '')
          filePath = filePath.substr(0, filePath.lastIndexOf('.')) + '.' + fileExt.template
        }
        components[com] = { src: filePath, name }
        resolve()
      })
    })
  }))
}

const cacheResolveComponents = {}
function resolveComponent (resourcePath, fileInfo, importsMap, localComponents, moduleId) {
  // 需要等待全局组件解析完成
  if (!globalComponents) {
    setTimeout(resolveComponent, 20, ...arguments)
  } else {
    // 保存当前所有参数，在热更时如果全局组件发生变化，需要进行组件更新
    cacheResolveComponents[resourcePath] = arguments
    const components = Object.assign({}, globalComponents, localComponents)
    components.isCompleted = true
    cacheFileInfo(resourcePath, fileInfo, { importsMap, components, moduleId })
  }
}

// 创建wxs文件
function createWxs (resourcePath, wxsContent, context, emitFile, fileExt) {
  const { filePath: wxsSrc } = getFiltersOutputSrc(context, resourcePath, fileExt)
  if (fileExt && fileExt.platform === 'my') {
    if (/^module.exports\s*=\s*.*/.test(wxsContent)) {
      wxsContent = wxsContent.replace(/^module.exports\s*=\s*/, 'export default ')
    }
  }
  emitFile(wxsSrc, wxsContent)
}

// 分析mixins解析外部引用Filters
const cacheResolveMixinsFilters = {}

function resolveMixinsFilters (mixins, mixinsFilters, resolveFn, context, projectRoot, babelOptions, emitFile, fileExt) {
  return Promise.all(Object.keys(mixins).map(k => {
    return new Promise((resolve, reject) => {
      resolveFn(context, mixins[k], (err, realSrc) => {
        if (err) return reject(err)
        if (cacheResolveMixinsFilters[realSrc]) {
          // 之前解析过该组件
          mixinsFilters.push(realSrc)
        } else {
          // 之前未解析过该组件
          // 读取文件
          const mixinsFileSource = fs.readFileSync(realSrc).toString()
          // 提取filters
          const mixinsFileFilter = extractScriptFilters(mixinsFileSource, babelOptions)
          if (mixinsFileFilter) {
            mixinsFilters.push(realSrc)
            cacheResolveMixinsFilters[realSrc] = mixinsFileFilter
            // 创建引用的wxs文件
            createWxs(realSrc, mixinsFileFilter.code, projectRoot, emitFile, fileExt)
          }
        }
        resolve()
      })
    })
  }))
}

// 解析Filters
function resolveFilters (resourcePath, fileInfo, scriptContent, babelOptions, mixinsFilters, context, projectRoot, emitFile, fileExt) {
  const resourceSrcPath = getFiltersOutputSrc(projectRoot, resourcePath, fileExt)
  const mixinsFiltersArray = []
  mixinsFilters.forEach((item) => {
    // 计算相对路径，只支持相对路径
    const itemSrcPath = getFiltersOutputSrc(projectRoot, item, fileExt)
    const realtivePath = path.join(path.relative(path.dirname(resourceSrcPath.filePath), path.dirname(itemSrcPath.filePath)), path.basename(itemSrcPath.filePath))
    mixinsFiltersArray.push({
      filePath: item,
      name: itemSrcPath.name,
      extractFilter: cacheResolveMixinsFilters[item],
      realtivePath: realtivePath
    })
  })
  // 提取脚本内的filters
  const scriptFilter = extractScriptFilters(scriptContent, babelOptions)
  // 合并外部引用和脚本内的filters
  const combineFilter = combineScriptAndMixinsFilters(scriptFilter, mixinsFiltersArray, babelOptions)
  // 保存文件信息
  if (combineFilter) {
    const filters = {
      isCompleted: true,
      src: path.join('./', path.basename(resourceSrcPath.filePath)),
      module: resourceSrcPath.name
    }
    cacheFileInfo(resourcePath, fileInfo, { filters })
    // 创建引用的wxs文件
    createWxs(resourcePath, combineFilter.code, projectRoot, emitFile, fileExt)
  }
}

module.exports = {
  compileMP,
  compileMPML,
  compileMPScript
}
