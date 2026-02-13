import { Inject, Provide, Scope, ScopeEnum } from "@midwayjs/core";
import { SysPrivateSettings, SysSettingsService } from "@certd/lib-server";
import ldap from "ldapjs";
import type { ILogger } from "@midwayjs/core";

export type LdapAuthResult = {
  username: string;
  nickName?: string;
  email?: string;
};

@Provide()
@Scope(ScopeEnum.Request, { allowDowngrade: true })
export class LdapService {
  @Inject()
  sysSettingsService: SysSettingsService;

  @Inject()
  logger: ILogger;

  private readonly connectTimeout = 10000;
  private readonly timeout = 10000;

  async authenticate(username: string, password: string): Promise<LdapAuthResult | null> {
    if (!username?.trim() || !password) {
      this.logger.warn("[LDAP] authenticate skipped: empty username or password");
      return null;
    }
    const conf = await this.sysSettingsService.getSetting<SysPrivateSettings>(SysPrivateSettings);
    const ldapConf = conf?.ldap;
    if (!ldapConf?.url?.trim() || !ldapConf?.userBaseDn?.trim()) {
      this.logger.warn("[LDAP] authenticate skipped: url or userBaseDn not configured");
      return null;
    }
    const userFilter = (ldapConf.userFilter || "(uid={{username}})").replace(/\{\{username\}\}/g, this.escapeLdapFilter(username.trim()));
    const url = ldapConf.url.trim();
    const client = ldap.createClient({
      url,
      connectTimeout: this.connectTimeout,
      timeout: this.timeout,
    });
    return new Promise<LdapAuthResult | null>((resolve) => {
      const done = (err: Error | null, result: LdapAuthResult | null) => {
        client.unbind(() => {});
        client.destroy();
        if (err) {
          this.logger.warn("[LDAP] auth failed for user %s: %s", username.trim(), err.message);
          resolve(null);
          return;
        }
        resolve(result);
      };
      client.on("error", (e: Error) => {
        done(e || new Error("LDAP connection error"), null);
      });
      const tryBindAndSearch = () => {
        const searchOpts: ldap.SearchOptions = {
          filter: userFilter,
          scope: "sub",
          attributes: ["dn", "uid", "cn", "mail", "sn", "displayName", "userPrincipalName"],
          sizeLimit: 1,
        };
        client.search(ldapConf.userBaseDn!, searchOpts, (searchErr, res) => {
          if (searchErr) {
            done(searchErr, null);
            return;
          }
          let found = false;
          res.on("searchEntry", (entry) => {
            if (found) return;
            found = true;
            const dn = entry.dn?.toString();
            const pojo = entry.pojo as Record<string, string | string[] | undefined>;
            if (!dn) {
              done(new Error("No DN"), null);
              return;
            }
            client.bind(dn, password, (bindErr) => {
              if (bindErr) {
                done(bindErr, null);
                return;
              }
              const uid = this.oneAttr(pojo, "uid") || username.trim();
              const nickName = this.oneAttr(pojo, "cn") || this.oneAttr(pojo, "displayName") || this.oneAttr(pojo, "sn") || uid;
              const email = this.oneAttr(pojo, "mail") || this.oneAttr(pojo, "userPrincipalName") || undefined;
              done(null, { username: uid, nickName, email });
            });
          });
          res.on("error", (e) => done(e, null));
          res.on("end", (result) => {
            if (!found && result?.status === 0) {
              done(new Error("User not found"), null);
            }
          });
        });
      };
      if (ldapConf.bindDn?.trim() && ldapConf.bindPassword !== undefined) {
        client.bind(ldapConf.bindDn.trim(), ldapConf.bindPassword, (bindErr) => {
          if (bindErr) {
            done(bindErr, null);
            return;
          }
          tryBindAndSearch();
        });
      } else {
        tryBindAndSearch();
      }
    });
  }

  private oneAttr(pojo: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = pojo[name];
    if (v == null) return undefined;
    if (Array.isArray(v)) return v[0] as string;
    return v as string;
  }

  private escapeLdapFilter(s: string): string {
    return s.replace(/[\\*()\x00]/g, (c) => {
      if (c === "\\") return "\\\\";
      if (c === "*") return "\\2a";
      if (c === "(") return "\\28";
      if (c === ")") return "\\29";
      if (c === "\x00") return "\\00";
      return c;
    });
  }

  /**
   * Test LDAP connection and optional bind (no user password).
   */
  async testConnection(): Promise<{ success: boolean; message?: string }> {
    const conf = await this.sysSettingsService.getSetting<SysPrivateSettings>(SysPrivateSettings);
    const ldapConf = conf?.ldap;
    if (!ldapConf?.url?.trim()) {
      return { success: false, message: "LDAP URL 未配置" };
    }
    if (!ldapConf?.userBaseDn?.trim()) {
      return { success: false, message: "用户 Base DN 未配置" };
    }
    const url = ldapConf.url.trim();
    const client = ldap.createClient({
      url,
      connectTimeout: this.connectTimeout,
      timeout: this.timeout,
    });
    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      const done = (success: boolean, message?: string) => {
        client.unbind(() => {});
        client.destroy();
        resolve({ success, message });
      };
      client.on("error", (err: Error) => {
        done(false, err?.message || "连接失败");
      });
      if (ldapConf.bindDn?.trim() && ldapConf.bindPassword !== undefined) {
        client.bind(ldapConf.bindDn.trim(), ldapConf.bindPassword, (bindErr) => {
          if (bindErr) {
            done(false, bindErr?.message || "绑定失败");
            return;
          }
          done(true);
        });
      } else {
        client.bind("", "", (bindErr) => {
          if (bindErr) {
            done(false, bindErr?.message || "匿名绑定失败");
            return;
          }
          done(true);
        });
      }
    });
  }
}
