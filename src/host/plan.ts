/** Plan 等受限 agent：服务端拒绝创建/续跑/resume（“不能写”由宿主权限系统负责，不重复实现）。 */
export function isRestrictedAgent(agentId: string, restrictedAgents: readonly string[]): boolean {
  return restrictedAgents.includes(agentId)
}
