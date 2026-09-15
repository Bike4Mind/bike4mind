declare module 'react-simple-code-editor' {
  import { Component } from 'react';

  export interface EditorProps {
    value: string;
    onValueChange: (value: string) => void;
    highlight: (value: string) => string | React.ReactNode;
    tabSize?: number;
    insertSpaces?: boolean;
    ignoreTabKey?: boolean;
    padding?: number;
    style?: React.CSSProperties;
    textareaId?: string;
    textareaClassName?: string;
    preClassName?: string;
    placeholder?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    form?: string;
    maxLength?: number;
    minLength?: number;
    name?: string;
    readOnly?: boolean;
    required?: boolean;
    onClick?: React.MouseEventHandler<HTMLTextAreaElement>;
    onFocus?: React.FocusEventHandler<HTMLTextAreaElement>;
    onBlur?: React.FocusEventHandler<HTMLTextAreaElement>;
    onKeyUp?: React.KeyboardEventHandler<HTMLTextAreaElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  }

  export default class Editor extends Component<EditorProps> {}
}
