export function getFileUrl(filePath: string): string {
    const isWindows = filePath.match(/^[a-zA-Z]:/);
    const pathPrefix = isWindows ? '/' + filePath[0] + ':' : '';
    const pathRest = isWindows ? filePath.slice(2) : filePath;
    return `file://${pathPrefix}${pathRest.split(/[/\\]/).map(encodeURIComponent).join('/')}`;
}
