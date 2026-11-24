/** English and Chinese dictionaries for the background image settings section. */
export const en = {
  title: 'Background', description: 'Use a picture of your own behind the app.',
  none: 'No background image', previewAlt: 'Current background image',
  choose: 'Choose image', replace: 'Replace image', clear: 'Remove image',
  opacity: 'Panel opacity {percent}%', localOnly: 'The image stays in this browser on this device and is never uploaded.',
  errorNotImage: 'That file is not an image.', errorTooLarge: 'That image is larger than 30 MB.', errorStorage: 'The image could not be saved in this browser.',
} as const

/** Key of the background image dictionary. */
export type BackgroundImageKey = keyof typeof en

export const zh: Record<BackgroundImageKey, string> = {
  title: '背景图片', description: '在应用后面使用你自己的图片。',
  none: '尚未设置背景图片', previewAlt: '当前背景图片',
  choose: '选择图片', replace: '更换图片', clear: '移除图片',
  opacity: '面板不透明度 {percent}%', localOnly: '图片只保存在本设备的浏览器里,不会上传。',
  errorNotImage: '该文件不是图片。', errorTooLarge: '图片超过 30 MB。', errorStorage: '图片无法保存到此浏览器。',
}
