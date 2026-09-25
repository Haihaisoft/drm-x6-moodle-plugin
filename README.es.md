# DRM-X 6.0 — Moodle

[English](README.md) | [简体中文](README.zh-Hans.md) | [Español](README.es.md)

Código fuente, ejemplos y guías para integrar vídeo protegido con **Moodle**. DRM-X 6.0 ofrece reproducción Multi-DRM mientras tu aplicación conserva sus usuarios, catálogo y reglas de acceso.

[Sitio de DRM-X 6.0](https://multi-drm.drm-x.com/es/) · [Documentación paso a paso](https://docs.drm-x.com/es/integrations/moodle-activity) · [Todas las integraciones](https://docs.drm-x.com/es/integrations/source-downloads) · [Ejemplos en línea](https://developer.drm-x.com/)

## Empieza aquí

Versión **20260925.7**, preliminar pública. Requisitos: **Moodle; consulta los requisitos del servidor en la guía**. Las licencias de los componentes y los avisos de terceros se conservan en sus carpetas de origen.

- Empieza por [`plugins/moodle/mod_drmx/README.md`](plugins/moodle/mod_drmx/README.md). Para instrucciones detalladas en español utiliza el enlace a la documentación.
- Archivos y puntos de extensión que debes configurar: **`Site administration → Plugins; DRM-X activity → Content ID`**.
- [Descarga el paquete probado para esta plataforma](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-20260925.7-source.zip) o clona este repositorio. Conserva la estructura de carpetas para que funcionen las dependencias locales del SDK.

1. Instala el [ZIP de la actividad DRM-X](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-activity-1.3.0-preview.6-3ed2cfca2d77.zip) con el instalador de plugins de Moodle. El [filtro](https://docs.drm-x.com/downloads/integrations/20260925.7/drmx-moodle-filter-1.3.0-preview.2-062604820a5a.zip) es opcional y no sustituye a la actividad.
2. Configura las credenciales del servidor en **Administración del sitio → Plugins**.
3. Añade una actividad DRM-X al curso e introduce el **Content ID** publicado. Conserva las matrículas, los roles y las restricciones de disponibilidad de Moodle.
4. Prueba alumnos con y sin permiso. Abrir la actividad no demuestra que se haya visto todo el vídeo. Al restaurarla se borra el Content ID; revísalo y vuelve a configurarlo.

Carpetas de código: `plugins/moodle/mod_drmx` y `plugins/moodle/filter_drmx`. Para la instalación normal utiliza los ZIP indicados, no el ZIP automático del repositorio de GitHub.

## Cómo funciona la integración

1. Cifra y publica un vídeo; copia su **Content ID**. Al publicar mediante 1aicloud/S3 configurado, DRM-X registra las URL de los medios. Si subes los archivos protegidos a tu propio servidor, registra primero sus URL DASH/HLS en DRM-X.
2. Configura **Site ID**, **Site Key** y **Access Key** en el servidor según la guía de la plataforma. Nunca incluyas estas credenciales en el código del navegador ni en Git.
3. Conserva tu inicio de sesión y comprueba las compras, membresías o matrículas del usuario actual. Asocia el ID de vídeo o lección de tu sitio con el DRM-X Content ID autorizado.
4. El backend solicita la reproducción y el reproductor recibe el manifiesto registrado y el **DRM License Token**. La integración habitual de streaming utiliza Content ID; no exige introducir la URL del manifiesto en el código del sitio.

## Antes de producción

Elimina las identidades de demostración, utiliza HTTPS y prueba usuarios sin sesión, sin permiso, con acceso revocado y autorizados en tus navegadores y dispositivos objetivo. Deniega el acceso si no puedes confirmar la autorización. Las licencias DRM ya emitidas mantienen la vigencia definida por su política. No expongas credenciales en registros, incidencias o capturas.

El código fuente, los paquetes SDK y los ejemplos están destinados a desarrolladores; las dependencias pueden requerir instalación desde sus registros habituales. Estas versiones preliminares no implican certificación para todos los navegadores, dispositivos, LMS o plataformas alojadas. Consulta los requisitos y límites específicos en la guía enlazada.

## Licencia y ayuda

Consulta [LICENSE](LICENSE) y las licencias y avisos de las carpetas del SDK, plugins y proveedores. La licencia del código no incluye una suscripción al servicio DRM-X ni licencias de LMS de terceros. Utiliza la [documentación](https://docs.drm-x.com/es/integrations/moodle-activity) para integrar y el [sitio de DRM-X 6.0](https://multi-drm.drm-x.com/es/) para conocer el servicio. Al comunicar un problema reproducible, no incluyas credenciales ni datos de clientes.
