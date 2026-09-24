// 宿主对「本地插件目录」的入口约定（packages/plugin/src/host.ts）：
//   entry(["server", ""]) -> path.resolve(dir, "server")、path.resolve(dir, "index")
// 即依次找 <目录>/server、<目录>/index；`main`/`exports` 都不参与这条路径。
// git/npm 安装走的是「包名 + exports 子路径」，与本文件无关。
export { default } from "./src/server"
