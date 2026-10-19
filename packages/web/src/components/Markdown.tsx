import React, { ComponentProps, useEffect, useRef, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { ExtraProps, default as ReactMarkdown } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { BundledLanguage, codeToHtml } from 'shiki';
import { Link } from '@/components/ui/dads/Link';
import { MermaidRenderer } from '@/features/exapp/invoke/components/MermaidRenderer';
import { ButtonCopy } from './ui/ButtonCopy';
import { Disclosure, DisclosureSummary } from './ui/dads/Disclosure';
import { ErrorText } from './ui/dads/ErrorText';
import { OverflowShadow } from './ui/OverflowShadow';

type Props = {
  className?: string;
  children: string;
  prefix?: string;
};

const LinkRenderer = (props: ComponentProps<'a'>) => {
  return (
    <Link
      id={props.id}
      href={props.href}
      target={props.href?.startsWith('#') ? '_self' : '_blank'}
      rel='noopener noreferrer'
    >
      {props.children}
    </Link>
  );
};
const ImageRenderer = (props: ComponentProps<'img'>) => {
  return <img id={props.id} src={props.src} alt={props.alt} {...props} />;
};

type CodeBlockProps = {
  children: string;
  lang: BundledLanguage;
};

function CodeBlock(props: CodeBlockProps) {
  const [html, setHtml] = useState<string>('');

  useEffect(() => {
    let isMounted = true;
    codeToHtml(props.children, {
      lang: props.lang,
      theme: 'github-light-high-contrast',
    }).then((result) => {
      if (isMounted) {
        setHtml(result);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [props.children, props.lang]);

  if (!html) {
    return <code>{props.children}</code>;
  }

  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by shiki
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

const SupRenderer = ({ children }: ComponentProps<'sup'>) => (
  <sup className='m-0.5 rounded-full bg-gray-200 px-1'>{children}</sup>
);

const TableRenderer = ({ children, node, ...rest }: ComponentProps<'table'> & ExtraProps) => (
  <OverflowShadow>
    <table {...rest}>{children}</table>
  </OverflowShadow>
);

const PreRenderer = ({ children, node, ...rest }: ComponentProps<'pre'> & ExtraProps) => {
  const codeEl = node?.children[0];
  if (codeEl?.type !== 'element' || codeEl.tagName !== 'code') {
    return <pre {...rest}>{children}</pre>;
  }

  const classNameProp = codeEl.properties?.className;
  const classNames = Array.isArray(classNameProp)
    ? classNameProp.filter((c): c is string => typeof c === 'string')
    : [];
  const languageClass = classNames.find((c) => c.startsWith('language-'));
  const language = languageClass?.slice('language-'.length);
  const textNode = codeEl.children[0];
  const codeText = textNode && 'value' in textNode ? String(textNode.value).replace(/\n$/, '') : '';

  if (language === 'mermaid') {
    return <MermaidRenderer code={codeText} />;
  }

  if (!language) {
    return <PlainCodeBlock codeText={codeText} />;
  }

  return <LanguageCodeBlock codeText={codeText} language={language} />;
};

const PlainCodeBlock = ({ codeText }: { codeText: string }) => {
  const targetRef = useRef<HTMLDivElement>(null);
  return (
    <div className='my-4 px-4 pt-4 pb-2 border border-solid-gray-420 rounded-12 [&_pre]:bg-transparent!'>
      <div ref={targetRef}>
        <CodeBlock lang={'text' as BundledLanguage}>{codeText}</CodeBlock>
      </div>
      <div className='flex justify-end mt-2'>
        <ButtonCopy text={codeText} targetRef={targetRef} />
      </div>
    </div>
  );
};

const LanguageCodeBlock = ({ codeText, language }: { codeText: string; language: string }) => {
  const targetRef = useRef<HTMLDivElement>(null);
  return (
    <Disclosure open className='my-4 border border-solid-gray-420 rounded-12'>
      <DisclosureSummary className='px-4 py-3 w-full'>{language}</DisclosureSummary>
      <div className='px-4 py-2 [&_pre]:bg-transparent!'>
        <div ref={targetRef}>
          <CodeBlock lang={language as BundledLanguage}>{codeText}</CodeBlock>
        </div>
        <div className='flex justify-end mt-2'>
          <ButtonCopy text={codeText} targetRef={targetRef} />
        </div>
      </div>
    </Disclosure>
  );
};

const CodeRenderer = ({ children }: ComponentProps<'code'>) => {
  const codeText = String(children).replace(/\n$/, '');
  return (
    <span className='inline rounded-4 border border-solid-gray-420 bg-solid-gray-50 px-1 py-0.5'>
      {codeText}
    </span>
  );
};

const components: ComponentProps<typeof ReactMarkdown>['components'] = {
  a: LinkRenderer,
  img: ImageRenderer,
  sup: SupRenderer,
  code: CodeRenderer,
  pre: PreRenderer,
  table: TableRenderer,
};

export const Markdown = React.memo(({ className, prefix, children }: Props) => {
  return (
    <ErrorBoundary fallback={<ErrorText>コンテンツの表示中にエラーが発生しました。</ErrorText>}>
      <div className={`prose prose-sm max-w-full ${className ?? ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          remarkRehypeOptions={{ clobberPrefix: prefix }}
          components={components}
        >
          {children}
        </ReactMarkdown>
      </div>
    </ErrorBoundary>
  );
});
