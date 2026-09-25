# DRM-X 6.0 — Moodle

[English](README.md) | [简体中文](README.zh-Hans.md) | [Español](README.es.md)

为 **Moodle** 提供受保护视频的开发源码、接入示例和操作指南。DRM-X 6.0 提供 Multi-DRM 播放能力，您的应用继续使用现有用户、内容目录和访问规则。

[DRM-X 6.0 官网](https://multi-drm.drm-x.com/zh-Hans/) · [分步接入文档](https://docs.drm-x.com/zh-Hans/integrations/moodle-activity) · [全部集成](https://docs.drm-x.com/zh-Hans/integrations/source-downloads) · [在线示例](https://developer.drm-x.com/)

## 从这里开始

发布版本 **20260925.7**，公开预览版。环境要求：**Moodle; server requirements in the guide**。各组件许可证及第三方声明保留在相应源码目录内。

- 首先阅读 [`plugins/moodle/mod_drmx/README.md`](plugins/moodle/mod_drmx/README.md)。详细的中文操作步骤请使用上方文档链接。
- 需要配置的文件和扩展点：**`Site administration → Plugins; DRM-X activity → Content ID`**。
- [下载已测试的平台集成包](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-20260925.7-source.zip)，或克隆本仓库。保留目录结构，确保本地 SDK 依赖路径有效。

1. 通过 Moodle 插件安装器安装 [DRM-X 活动安装包](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-activity-1.3.0-preview.6-3ed2cfca2d77.zip)。[过滤器安装包](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-filter-1.3.0-preview.2-062604820a5a.zip)为可选组件，不能代替活动插件。
2. 在 **网站管理 → 插件** 中配置服务器凭据。
3. 在课程中添加 DRM-X 活动，填写已发布内容的 **Content ID**。保留 Moodle 的报名、角色和可用性限制。
4. 测试有权限和无权限的学员。打开活动不代表看完视频；恢复活动后 Content ID 会清空，需要重新核对并设置。

源码目录：`plugins/moodle/mod_drmx` 和 `plugins/moodle/filter_drmx`。常规安装请使用上述安装包链接，不要直接上传 GitHub 自动生成的仓库 ZIP。

## 接入流程

1. 加密并发布视频，复制其 **Content ID**。通过已配置的 1aicloud/S3 发布时，DRM-X 会记录媒体 URL。如果把受保护文件上传到自己的服务器，请先在 DRM-X 中登记其 DASH/HLS 媒体 URL。
2. 按平台指南在服务器端配置 **Site ID**、**Site Key** 和 **Access Key**。不要将这些凭据放入浏览器代码或 Git 仓库。
3. 保留现有登录系统，检查当前用户的购买、会员或课程报名权限，将网站自己的视频或课时 ID 映射到允许访问的 DRM-X Content ID。
4. 后端申请播放，播放器获得已登记的播放清单和 **DRM License Token**。常规流媒体接入只需提供 Content ID，不需要在网站代码中填写 manifest URL。

## 上线前检查

移除本地演示身份、启用 HTTPS，并在目标浏览器和设备上测试未登录、无权限、已撤销及正常授权的情况。无法确认权限时应拒绝访问。已签发的 DRM 许可证仍按自身策略有效期执行。不要在日志、问题反馈或截图中暴露服务器凭据。

本仓库面向开发者，提供源码、SDK 包和示例；运行依赖可能需要从相应软件包仓库安装。预览版本不代表所有浏览器、设备、LMS 或托管平台均已通过认证。各平台前置条件和限制请以链接中的指南为准。

## 许可证与帮助

请阅读 [LICENSE](LICENSE) 以及 SDK、插件和 vendor 目录中的许可证与声明。源码许可证不包含 DRM-X 服务订阅或第三方 LMS 授权。接入问题请参阅[文档](https://docs.drm-x.com/zh-Hans/integrations/moodle-activity)，服务介绍请访问 [DRM-X 6.0 官网](https://multi-drm.drm-x.com/zh-Hans/)。提交可复现的代码问题时，不要附带凭据或客户数据。
