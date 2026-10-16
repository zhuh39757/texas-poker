// 给玩家看的错误（规则不允许、输入不对等），其他异常都算服务器 bug
// code 供程序区分错误类型，比如口令错误要计入防暴力尝试
export class UserError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
